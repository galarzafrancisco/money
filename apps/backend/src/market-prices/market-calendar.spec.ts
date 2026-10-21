import { addDays, dateInZone, dateRange, daysBetween, isWeekend, zonedTimeToUtc } from './market-calendar';

describe('market calendar', () => {
  it('converts exchange closing times to UTC across daylight saving', () => {
    // ASX 16:00: AEDT (UTC+11) in January, AEST (UTC+10) in July
    expect(zonedTimeToUtc('2025-01-06', '16:00', 'Australia/Sydney').toISOString()).toBe('2025-01-06T05:00:00.000Z');
    expect(zonedTimeToUtc('2025-07-07', '16:00', 'Australia/Sydney').toISOString()).toBe('2025-07-07T06:00:00.000Z');
    // NYSE 16:00: EST (UTC−5) / EDT (UTC−4); US DST started 2025-03-09
    expect(zonedTimeToUtc('2025-03-07', '16:00', 'America/New_York').toISOString()).toBe('2025-03-07T21:00:00.000Z');
    expect(zonedTimeToUtc('2025-03-10', '16:00', 'America/New_York').toISOString()).toBe('2025-03-10T20:00:00.000Z');
    expect(zonedTimeToUtc('2025-06-02', '16:30:00', 'Europe/London').toISOString()).toBe('2025-06-02T15:30:00.000Z');
  });

  it('gives the trading date in the exchange time zone, not UTC', () => {
    // 23:30 UTC on the 6th is already the 7th in Sydney
    expect(dateInZone(new Date('2025-01-06T23:30:00Z'), 'Australia/Sydney')).toBe('2025-01-07');
    expect(dateInZone(new Date('2025-01-07T02:00:00Z'), 'America/New_York')).toBe('2025-01-06');
  });

  it('does date arithmetic on calendar dates', () => {
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2025-01-01', -1)).toBe('2024-12-31');
    expect(daysBetween('2025-03-07', '2025-03-10')).toBe(3);
    expect(dateRange('2025-03-07', '2025-03-10')).toEqual(['2025-03-07', '2025-03-08', '2025-03-09', '2025-03-10']);
    expect(isWeekend('2025-03-08')).toBe(true);
    expect(isWeekend('2025-03-09')).toBe(true);
    expect(isWeekend('2025-03-10')).toBe(false);
  });
});
