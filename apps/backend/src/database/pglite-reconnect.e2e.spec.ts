import { Pool } from 'pg';
import { startPgliteServer, usingRealPostgres } from '../test-support/test-app';

/**
 * Regression test for the PGlite socket server's single-slot race. pg drops
 * the pool's only client (on a connection error, or an idle close) and opens
 * a replacement straight away. The server frees the old socket's slot only
 * on a later tick, so with one slot the replacement was refused ("Too many
 * connections", seen by pg as "Connection terminated unexpectedly"), failing
 * that request and hanging the suite. test/pglite-server.mjs and
 * in-memory-database.ts give the server spare slots.
 */
(usingRealPostgres ? describe.skip : describe)('PGlite socket server reconnects (pool of one)', () => {
  it('serves the replacement connection right after the pool drops its client', async () => {
    const server = await startPgliteServer();
    const pool = new Pool({ connectionString: server.url, max: 1, idleTimeoutMillis: 0 });
    try {
      for (let i = 0; i < 30; i++) {
        const client = await pool.connect();
        await client.query('SELECT 1');
        client.release(true); // destroy it, as pg-pool does after a connection error
        const { rows } = await pool.query('SELECT $1::int AS n', [i]);
        expect(rows[0].n).toBe(i);
      }
    } finally {
      await pool.end();
      await server.stop();
    }
  });
});
