import { daysBetweenInclusive, parseTaxYear, taxYearLabel, taxYearOf, taxYearPeriod } from './financial-year';
import { DEPRECIATION_RULES_VERSION, defaultHorizon, depreciationSchedule, type DepreciationInput } from './depreciation-math';

const base: DepreciationInput = {
  cost: '1000',
  startDate: '2026-07-01',
  method: 'PRIME_COST',
  effectiveLifeYears: '4',
  ratePercent: null,
  defaultUsePercent: '100',
  disposedOn: null,
  disposalProceeds: null,
};

describe('Australian financial years', () => {
  it('splits years on 30 June / 1 July', () => {
    expect(taxYearOf('2026-06-30')).toBe(2025);
    expect(taxYearOf('2026-07-01')).toBe(2026);
    expect(taxYearOf('2027-01-15')).toBe(2026);
  });

  it('parses the usual ways of writing a year and refuses mismatched halves', () => {
    for (const text of ['2026-27', 'FY2026-27', 'fy 2026-27', '2026–27', '2026/27', '2026-2027']) expect(parseTaxYear(text)).toBe(2026);
    expect(parseTaxYear('2026-28')).toBeNull();
    expect(parseTaxYear('2026')).toBeNull();
    expect(parseTaxYear('1999-00')).toBe(1999);
    expect(taxYearLabel(1999)).toBe('1999-00');
    expect(taxYearLabel(2026)).toBe('2026-27');
  });

  it('counts 366 days in a year that contains 29 February', () => {
    expect(taxYearPeriod(2026)).toMatchObject({ start: '2026-07-01', end: '2027-06-30', days: 365 });
    expect(taxYearPeriod(2027)).toMatchObject({ start: '2027-07-01', end: '2028-06-30', days: 366 });
    expect(daysBetweenInclusive('2026-01-01', '2026-06-30')).toBe(181);
    expect(daysBetweenInclusive('2026-07-02', '2026-07-01')).toBe(0);
  });
});

describe('depreciation schedule', () => {
  it('prime cost: full years until written off', () => {
    const s = depreciationSchedule(base, 2040);
    expect(s.rulesVersion).toBe(DEPRECIATION_RULES_VERSION);
    expect(s.ratePercent).toBe('25');
    expect(s.rows.map((r) => [r.taxYear, r.openingValue, r.decline, r.closingValue])).toEqual([
      ['2026-27', '1000.00', '250.00', '750.00'],
      ['2027-28', '750.00', '250.00', '500.00'],
      ['2028-29', '500.00', '250.00', '250.00'],
      ['2029-30', '250.00', '250.00', '0.00'],
    ]);
    expect(s.endReason).toBe('WRITTEN_OFF');
    expect(s.totals).toEqual({ decline: '1000.00', deduction: '1000.00', privatePortion: '0.00' });
  });

  it('prime cost: apportions a partial first year by days held and caps the last year at the remaining value', () => {
    const s = depreciationSchedule({ ...base, startDate: '2026-01-01' }, 2040);
    expect(s.rows[0]).toMatchObject({ taxYear: '2025-26', periodStart: '2026-01-01', periodEnd: '2026-06-30', daysHeld: 181, daysInYear: 365, decline: '123.97' });
    expect(s.rows.map((r) => r.decline)).toEqual(['123.97', '250.00', '250.00', '250.00', '126.03']);
    expect(s.rows.at(-1)?.workings).toContain('capped at the remaining value 126.03');
    expect(s.totals.decline).toBe('1000.00');
  });

  it('diminishing value: rate 200 % / life on the opening value, never past the horizon', () => {
    const s = depreciationSchedule({ ...base, method: 'DIMINISHING_VALUE' }, 2029);
    expect(s.ratePercent).toBe('50');
    expect(s.rows.map((r) => r.decline)).toEqual(['500.00', '250.00', '125.00', '62.50']);
    expect(s.rows.at(-1)?.closingValue).toBe('62.50');
    expect(s.endReason).toBe('HORIZON');
  });

  it('uses each year\'s own work-use percentage, falling back to the default', () => {
    const s = depreciationSchedule({ ...base, defaultUsePercent: '80', usePercentByYear: new Map([[2027, '50']]) }, 2029);
    expect(s.rows.map((r) => [r.taxYear, r.usePercent, r.usePercentSource, r.decline, r.deduction, r.privatePortion])).toEqual([
      ['2026-27', '80', 'default', '250.00', '200.00', '50.00'],
      ['2027-28', '50', 'year', '250.00', '125.00', '125.00'],
      ['2028-29', '80', 'default', '250.00', '200.00', '50.00'],
      ['2029-30', '80', 'default', '250.00', '200.00', '50.00'],
    ]);
    // The asset still declines in full: private use reduces the deduction, not the decline
    expect(s.rows.at(-1)?.closingValue).toBe('0.00');
  });

  it('stops at disposal with an estimated balancing adjustment, using a leap year\'s 366 days', () => {
    const s = depreciationSchedule({ ...base, defaultUsePercent: '50', disposedOn: '2027-12-31', disposalProceeds: '700' }, 2040);
    expect(s.rows).toHaveLength(2);
    expect(s.rows[1]).toMatchObject({ taxYear: '2027-28', daysHeld: 184, daysInYear: 366, decline: '125.68', closingValue: '0.00', deduction: '62.84' });
    expect(s.rows[1].balancingAdjustment).toEqual({ terminationValue: '700.00', adjustableValue: '624.32', amount: '75.68', taxableAmount: '37.84' });
    expect(s.endReason).toBe('DISPOSED');
  });

  it('a rate override wins over effective life', () => {
    const s = depreciationSchedule({ ...base, ratePercent: '40', effectiveLifeYears: null }, 2026);
    expect(s.rateSource).toBe('override');
    expect(s.rows[0].decline).toBe('400.00');
  });

  it('IMMEDIATE writes off the full cost in the first year of use, once', () => {
    const s = depreciationSchedule({ ...base, method: 'IMMEDIATE', cost: '299', startDate: '2026-08-01', effectiveLifeYears: null }, 2030);
    expect(s.rows.map((r) => [r.taxYear, r.decline])).toEqual([['2026-27', '299.00']]);
    expect(s.endReason).toBe('WRITTEN_OFF');
  });

  it('an asset not yet in use has no schedule', () => {
    const s = depreciationSchedule({ ...base, startDate: null }, 2030);
    expect(s.rows).toEqual([]);
    expect(s.endReason).toBe('NOT_STARTED');
  });

  it('is deterministic', () => {
    const input = { ...base, method: 'DIMINISHING_VALUE' as const, cost: '6249.99', startDate: '2025-10-15', effectiveLifeYears: '3' };
    expect(depreciationSchedule(input, 2032)).toEqual(depreciationSchedule(input, 2032));
  });

  it('the default horizon covers a prime-cost write-off and the current year', () => {
    expect(defaultHorizon(base, 2026)).toBe(2030);
    expect(defaultHorizon(base, 2035)).toBe(2035);
    expect(defaultHorizon({ ...base, startDate: null }, 2026)).toBe(2026);
  });
});
