// Runs an in-memory PGlite behind the Postgres wire protocol, for tests.
// Started as a child process (outside Jest's module sandbox, which PGlite's
// dynamic imports do not work in). Reports its port over IPC.
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const db = await PGlite.create();
// Spare connection slots: the server frees a closed socket's slot only on a
// later tick, so with its default of 1 the pool's replacement connection
// (after pg drops a client on an error or idle close) can be refused with
// "Too many connections". The app's pool still opens one connection at a
// time; PGlite's query queue serializes them either way.
const server = new PGLiteSocketServer({ db, port: 0, host: '127.0.0.1', maxConnections: 4 });
await server.start();
const address = server.getServerConn();
process.send?.({ ready: true, address });
const stop = async () => {
  await server.stop();
  await db.close();
  process.exit(0);
};
process.on('message', (message) => message === 'stop' && void stop());
process.on('disconnect', () => void stop());
