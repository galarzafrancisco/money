import { dataSourceOptions } from './data-source-options';

describe('dataSourceOptions', () => {
  const postgres = (poolMax: number) =>
    dataSourceOptions({ driver: 'postgres', url: 'postgresql://u:p@127.0.0.1:5432/db', ssl: false, poolMax }) as { extra: Record<string, unknown> };

  it('keeps the single connection of a one-connection pool open (PGlite socket server), so it is never closed and reopened', () => {
    expect(postgres(1).extra).toEqual({ max: 1, idleTimeoutMillis: 0 });
  });

  it('leaves pg idle handling alone for a real connection pool', () => {
    expect(postgres(5).extra).toEqual({ max: 5 });
  });
});
