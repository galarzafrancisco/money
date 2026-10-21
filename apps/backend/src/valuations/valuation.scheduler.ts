import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/env.config';
import { ValuationJobService } from './valuation-job.service';

/**
 * Runs the valuation job in-process: shortly after startup (catching up on
 * anything missed while the app was down) and then every
 * VALUATION_JOB_INTERVAL_MINUTES. Each run only does what is due, so
 * frequent runs are cheap. Several instances may run this; the job's
 * database lease lets only one work at a time.
 */
@Injectable()
export class ValuationScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('ValuationScheduler');
  private timers: NodeJS.Timeout[] = [];
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
    await this.running;
  }

  private tick(): void {
    if (this.running) return;
    this.running = this.job
      .runOnce()
      .catch((error) => this.logger.error(`Valuation run crashed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        this.running = null;
      });
  }
}
