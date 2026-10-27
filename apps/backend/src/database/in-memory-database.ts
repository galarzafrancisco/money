import type { AppConfig } from '../config/env.config';

export type ResolvedDatabase = Exclude<AppConfig['database'], { driver: 'memory' }>;

/**
 * Connection slots on the PGlite socket server. The pool opens one
 * connection, but the server frees a closed socket's slot only on a later
 * tick: with a single slot, the pool's replacement connection (after pg drops
 * a client on an error or idle close) can be refused with "Too many
 * connections", failing the request and every one after it. Spare slots
 * absorb that overlap. PGlite's query queue serializes queries either way
 * and keeps an open transaction to its own connection.
 */
export const PGLITE_SOCKET_MAX_CONNECTIONS = 4;

export type RunningDatabase = {
  database: ResolvedDatabase;
  /** Stops the embedded server, if one was started. All in-memory data is lost */
  stop: () => Promise<void>;
};

/**
 * Turns DATABASE_MODE=memory into a real Postgres connection: an in-memory
 * PGlite served over the Postgres wire protocol on 127.0.0.1 (random port),
 * reached through the normal `pg` driver with a pool of ONE connection.
 *
 * Why not typeorm-pglite in process: it runs every TypeORM connection through
 * one shared PGlite session, so concurrent transactions interleave. A rollback
 * in one request does not undo its writes if another request commits in
 * between, and FOR UPDATE row locks protect nothing. One pooled connection
 * makes TypeORM queue transactions, which is what the PGlite test suite does
 * too.
 *
 * The data lives only in this process's memory. Every restart, redeploy or
 * crash starts from an empty database.
 */
export async function startDatabase(database: AppConfig['database']): Promise<RunningDatabase> {
  if (database.driver !== 'memory') return { database, stop: async () => undefined };

  // Both packages are ESM-only; dynamic import keeps them out of CommonJS require()
  const { PGlite } = await import('@electric-sql/pglite');
  const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');
  const db = await PGlite.create();
  // Spare slots (see PGLITE_SOCKET_MAX_CONNECTIONS): the pool still uses one connection
  const server = new PGLiteSocketServer({ db, host: '127.0.0.1', port: 0, maxConnections: PGLITE_SOCKET_MAX_CONNECTIONS });
  await server.start();
  const address = server.getServerConn();

  return {
    database: { driver: 'postgres', url: `postgresql://postgres:postgres@${address}/postgres`, ssl: false, poolMax: 1 },
    stop: async () => {
      await server.stop();
      await db.close();
    },
  };
}
