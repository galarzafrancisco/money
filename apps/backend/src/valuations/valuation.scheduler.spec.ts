import type { AppConfig } from '../config/env.config';
import type { ValuationJobService } from './valuation-job.service';
import { ValuationScheduler } from './valuation.scheduler';

describe('ValuationScheduler', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const config = { valuations: { jobEnabled: true, intervalMinutes: 60, catchupDelaySeconds: 30 } } as AppConfig;
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  it('runs again after the catch-up delay while a backfill has dates left, then waits for the interval', async () => {
    const outcomes = [true, true, false];
    const runOnce = jest.fn(async () => ({ moreDue: outcomes.shift() ?? false }));
    const scheduler = new ValuationScheduler(config, { runOnce } as unknown as ValuationJobService);
    scheduler.onApplicationBootstrap();

    await jest.advanceTimersByTimeAsync(15_000);
    expect(runOnce).toHaveBeenCalledTimes(1);
    await flush();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(runOnce).toHaveBeenCalledTimes(2);
    await flush();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(runOnce).toHaveBeenCalledTimes(3);
    await flush();
    // Caught up: nothing until the hourly run
    await jest.advanceTimersByTimeAsync(30 * 60_000);
    expect(runOnce).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(30 * 60_000);
    expect(runOnce).toHaveBeenCalledTimes(4);
    await scheduler.onApplicationShutdown();
  });

  it('schedules no catch-up after shutdown', async () => {
    const runOnce = jest.fn(async () => ({ moreDue: true }));
    const scheduler = new ValuationScheduler(config, { runOnce } as unknown as ValuationJobService);
    scheduler.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(15_000);
    await scheduler.onApplicationShutdown();
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(runOnce).toHaveBeenCalledTimes(1);
  });
});
