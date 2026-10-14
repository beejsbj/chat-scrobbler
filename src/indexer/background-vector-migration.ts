import {openIndex} from './sqlite';
import {migrateLegacyVectors} from './vector-store';
import {acquireBackfillLock} from './backfill-lock';
import {deferWalCheckpoints} from './background-wal-checkpoint';

export type VectorMigrationReport = ReturnType<typeof migrateLegacyVectors>;
export interface BackgroundVectorMigrationOptions {
  signal?: AbortSignal;
  yield?: () => Promise<void>;
  /** Cumulative counts for this invocation and the durable legacy rowid cursor. */
  progress?: (report: VectorMigrationReport) => void;
}

/** A caller's yield may stay pending during shutdown. Release our lease promptly
 * on abort, while still observing eventual rejection of that caller promise. */
function wait(signal: AbortSignal | undefined, run: () => Promise<void>): Promise<void> {
  signal?.throwIfAborted();
  if (!signal) return run();
  return new Promise<void>((resolve, reject) => {
    const finish = (done: () => void) => {signal.removeEventListener('abort', abort); done();};
    const abort = () => finish(() => reject(signal.reason));
    signal.addEventListener('abort', abort, {once: true});
    Promise.resolve().then(() => {signal.throwIfAborted(); return run();}).then(
      () => finish(resolve), error => finish(() => reject(error)));
  });
}

/** Start after listening, independently of embedding budgets and provider setup.
 * Converts stored JSON only. Owns its connection and the shared heartbeat lease;
 * the existing migration transaction fences both writes and cursor advancement.
 * Abort/failure rejects; committed pages remain resumable on the next invocation. */
export async function migrateVectorsInBackground(
  indexPath: string, opts: BackgroundVectorMigrationOptions = {},
): Promise<VectorMigrationReport> {
  const report: VectorMigrationReport = {scanned: 0, converted: 0, invalid: 0, cursor: 0};
  let lease: ReturnType<typeof acquireBackfillLock> = null;
  let db: ReturnType<typeof openIndex> | undefined;
  const pause = async (signal = opts.signal) => {
    signal?.throwIfAborted();
    await wait(signal, () => opts.yield?.() ?? Bun.sleep(0));
    signal?.throwIfAborted();
  };
  try {
    await pause();
    while (!(lease = acquireBackfillLock(indexPath))) {
      await pause();
      await wait(opts.signal, () => Bun.sleep(250));
      opts.signal?.throwIfAborted();
    }
    const signal = opts.signal ? AbortSignal.any([opts.signal, lease.signal]) : lease.signal;
    db = openIndex(indexPath);
    const writer = db, owner = lease, wal = deferWalCheckpoints(writer);
    try {
      while (true) {
        signal.throwIfAborted();
        const batch = migrateLegacyVectors(writer, {limit: 32, assertLease: () => owner.assertOwned(writer)});
        report.scanned += batch.scanned;
        report.converted += batch.converted;
        report.invalid += batch.invalid;
        report.cursor = batch.cursor;
        if (!batch.scanned) break;
        opts.progress?.({...report});
        await pause(signal);
        await wal.checkpoint();
        signal.throwIfAborted();
        if (batch.scanned < 32) break;
      }
      return report;
    } finally {wal.restore();}
  } finally {
    try {db?.close();} finally {lease?.release();}
  }
}
