import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/env.config';
import { ValuationJobService } from './valuation-job.service';

/**
 * Runs the valuation job in-process: shortly after startup (catching up on
 * anything missed while the app was down) and then every
 * VALUATION_JOB_INTERVAL_MINUTES. Each run only does what is due, so
 * frequent runs are cheap. While a backfill is in progress (a run left due
 * dates behind), the next run starts after VALUATION_CATCHUP_DELAY_SECONDS
 * instead, so long histories fill in batches without waiting an interval
 * each. Several instances may run this; the job's database lease lets only
 * one work at a time.
 */
@Injectable()
export class ValuationScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('ValuationScheduler');
  private timers: NodeJS.Timeout[] = [];
  private catchup: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly job: ValuationJobService,
  ) {}

  onApplicationBootstrap(): void {
    const { jobEnabled, intervalMinutes } = this.config.valuations;
    if (!jobEnabled) {
      this.logger.log('Daily valuation job not scheduled in this process');
      return;
    }
    this.logger.log(`Daily valuation job runs every ${intervalMinutes} min`);
    this.timers.push(setTimeout(() => this.tick(), 15_000).unref());
    this.timers.push(setInterval(() => this.tick(), intervalMinutes * 60_000).unref());
  }

  async onApplicationShutdown(): Promise<void> {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    if (this.catchup) clearTimeout(this.catchup);
    this.catchup = null;
    await this.running;
  }

  private tick(): void {
    if (this.running) return;
    this.running = this.job
      .runOnce()
      .then((summary) => {
        // Still scheduled (not shutting down) and a backfill is in progress: go again soon
        if (summary.moreDue && this.timers.length > 0 && !this.catchup) {
          this.catchup = setTimeout(() => {
            this.catchup = null;
            this.tick();
          }, this.config.valuations.catchupDelaySeconds * 1000).unref();
        }
      })
      .catch((error) => this.logger.error(`Valuation run crashed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        this.running = null;
      });
  }
}
