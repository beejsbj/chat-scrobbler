import type {Database} from 'bun:sqlite';
import {stat} from 'node:fs/promises';
import {Worker} from 'node:worker_threads';

const walTargetBytes = 4 * 1024 * 1024;

// Inline JavaScript keeps the worker available in compiled Bun binaries too.
// Checkpoint I/O and fsync run here, never on the request event loop.
const checkpointWorker = `
  const {workerData, parentPort} = require('node:worker_threads');
  const {Database} = require('bun:sqlite');
  const db = new Database(workerData, {readwrite: true});
  try {
    db.run('PRAGMA busy_timeout=0');
    parentPort.postMessage(db.query('PRAGMA wal_checkpoint(TRUNCATE)').get().busy);
  } finally {db.close();}
`;

/** Defer this connection's commit checkpoints. Call checkpoint between bounded
 * batches, then restore in finally. The target is soft: a pinned reader or another
 * writer can prevent truncation. Never wait for their locks on the request loop.
 * Other connections retain their own autocheckpoint policy. */
export function deferWalCheckpoints(db: Database) {
  const original = (db.query('PRAGMA wal_autocheckpoint').get() as {wal_autocheckpoint: number}).wal_autocheckpoint;
  const path = (db.query('PRAGMA database_list').all() as Array<{name: string; file: string}>)
    .find(row => row.name === 'main')?.file;
  db.run('PRAGMA wal_autocheckpoint=0');
  let retryAfter = 0;
  return {
    async checkpoint(): Promise<void> {
      if (!path || Date.now() < retryAfter) return; // In-memory databases have no WAL file.
      let size: number;
      try {size = (await stat(`${path}-wal`)).size;}
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      if (size < walTargetBytes) return;
      const busy = await new Promise<boolean>((resolve, reject) => {
        const worker = new Worker(checkpointWorker, {eval: true, workerData: path});
        let busy = true;
        worker.once('message', value => {busy = Boolean(value);});
        worker.once('error', reject);
        worker.once('exit', code => code === 0 ? resolve(busy) : reject(new Error('background WAL checkpoint failed')));
      });
      // Pinned readers must not spawn a new worker on every CPU batch.
      if (busy) retryAfter = Date.now() + 1000;
    },
    restore(): void {db.run(`PRAGMA wal_autocheckpoint=${original}`);},
  };
}
