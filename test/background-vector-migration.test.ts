import {expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openIndex} from '../src/indexer/sqlite';
import {decodeVector} from '../src/indexer/vector-store';
import {acquireBackfillLock, readBackfillLease} from '../src/indexer/backfill-lock';
import {migrateVectorsInBackground, type VectorMigrationReport} from '../src/indexer/background-vector-migration';

function setup(rows: number) {
  const root = mkdtempSync(join(tmpdir(), 'vector-migration-'));
  const path = join(root, 'index.db');
  const db = openIndex(path);
  db.transaction(() => {
    for (let i = 0; i < rows; i++) db.run(`INSERT INTO message_embeddings
      (session_id,message_id,embedding,text,title,provider_kind,provider_model,dimension)
      VALUES (?,?,?,?,?,?,?,?)`, ['chatgpt:test', `m${i}`, '[1,0]', 'archived words', 'T', 'test', 'legacy', 2]);
  })();
  return {root, path, db, cleanup() {db.close(); rmSync(root, {recursive: true, force: true});}};
}

test('background migration converts persisted JSON with bounded yields and cumulative progress, preserving the source', async () => {
  const {path, db, cleanup} = setup(97);
  try {
    let previous = 0, yields = 0;
    const progress: VectorMigrationReport[] = [];
    const result = await migrateVectorsInBackground(path, {
      yield: async () => {
        const {n} = db.query('SELECT COUNT(*) AS n FROM message_vectors').get() as {n: number};
        expect(n - previous).toBeLessThanOrEqual(32);
        previous = n;
        yields++;
        await Bun.sleep(0);
      },
      progress: report => {progress.push(report);},
    });
    expect(result).toMatchObject({scanned: 97, converted: 97, invalid: 0, cursor: 97,
      lease: {state: 'released', recovered: false}});
    expect(yields).toBeGreaterThanOrEqual(5);
    expect(progress.map(report => report.scanned)).toEqual([32, 64, 96, 97]);
    expect(progress[0].converted).toBe(32); // Caller snapshots must not mutate later.
    expect(progress[0].lease).toMatchObject({state: 'held', recovered: false});
    expect(db.query('SELECT COUNT(*) AS n FROM message_embeddings').get()).toEqual({n: 97});
    const row = db.query("SELECT embedding,typeof(embedding) AS type FROM message_vectors WHERE message_id='m0'").get() as {embedding: Uint8Array; type: string};
    expect(row.type).toBe('blob');
    expect(Array.from(decodeVector(row.embedding, 2))).toEqual([1, 0]);
    expect(readBackfillLease(path)).toBeNull();
    expect(await migrateVectorsInBackground(path)).toMatchObject({scanned: 0, converted: 0, invalid: 0, cursor: 97});
  } finally {cleanup();}
});

test('migration retains recovery metadata after releasing an abandoned fake-clock lease, even with no legacy rows', async () => {
  for (const rows of [0, 1]) {
    const {path, cleanup} = setup(rows);
    // This holder is already expired against real time and never heartbeats
    // during this test, representing a process that died without releasing.
    const abandoned = acquireBackfillLock(path, {now: () => 1000})!;
    const progress: VectorMigrationReport[] = [];
    try {
      const result = await migrateVectorsInBackground(path, {progress: report => {progress.push(report);}});
      expect(result).toMatchObject({scanned: rows, converted: rows, lease: {
        state: 'released', recovered: true, recoveries: 1,
      }});
      expect(result.lease!.recovered_at).toBeGreaterThan(61_000);
      expect(result.lease!.expires_at).toBeGreaterThan(result.lease!.heartbeat_at);
      if (rows) {
        expect(progress[0].lease).toMatchObject({state: 'held', recovered: true, recoveries: 1});
        expect(progress[0].lease!.recovered_at).toBe(result.lease!.recovered_at);
      }
      expect(readBackfillLease(path)).toBeNull();
    } finally {abandoned.release(); cleanup();}
  }
});

test('a busy lease is retried after its holder releases and migration excludes another writer', async () => {
  const {path, db, cleanup} = setup(33);
  const holder = acquireBackfillLock(path)!;
  let yields = 0;
  try {
    const result = await migrateVectorsInBackground(path, {
      yield: async () => {
        if (++yields === 2) {
          expect(db.query('SELECT COUNT(*) AS n FROM message_vectors').get()).toEqual({n: 0});
          holder.release();
        }
      },
      progress: () => {expect(acquireBackfillLock(path)).toBeNull();},
    });
    expect(result).toMatchObject({scanned: 33, converted: 33, invalid: 0});
    expect(yields).toBeGreaterThanOrEqual(4);
    expect(readBackfillLease(path)).toBeNull();
  } finally {holder.release(); cleanup();}
});

test('cancellation after a committed page releases the lease and resumes without reprocessing', async () => {
  const {path, db, cleanup} = setup(65);
  const abort = new AbortController();
  const reason = new Error('migration stopped');
  let entered!: () => void, resume!: () => void;
  const waiting = new Promise<void>(resolve => {entered = resolve;});
  const gate = new Promise<void>(resolve => {resume = resolve;});
  let yields = 0;
  const progress: VectorMigrationReport[] = [];
  const job = migrateVectorsInBackground(path, {signal: abort.signal,
    progress: report => {progress.push(report);},
    yield: async () => {if (++yields === 2) {entered(); await gate;}},
  }).then(() => null, error => error);
  try {
    await waiting;
    expect(readBackfillLease(path)?.state).toBe('held');
    abort.abort(reason);
    expect(await Promise.race([job, Bun.sleep(100).then(() => 'still waiting')])).toBe(reason);
    expect(readBackfillLease(path)).toBeNull();
    expect(progress.map(report => report.scanned)).toEqual([32, 32]);
    expect(progress.map(report => report.lease?.state)).toEqual(['held', 'released']);
    expect(db.query('SELECT COUNT(*) AS n FROM message_vectors').get()).toEqual({n: 32});
    expect(await migrateVectorsInBackground(path)).toMatchObject({scanned: 33, converted: 33, invalid: 0, cursor: 65});
  } finally {resume(); await job; cleanup();}
});

test('corrupt JSON advances the durable cursor and an existing binary snapshot is preserved', async () => {
  const {path, db, cleanup} = setup(3);
  try {
    db.run("UPDATE message_embeddings SET embedding='bad-json' WHERE message_id='m1'");
    db.run(`INSERT INTO message_vectors
      (session_id,message_id,provider_kind,provider_model,dimension,embedding,text,title)
      VALUES (?,?,?,?,?,?,?,?)`, ['chatgpt:test', 'm2', 'test', 'legacy', 2,
      new Uint8Array(new Float32Array([0, 1]).buffer), 'newer words', 'T']);
    expect(await migrateVectorsInBackground(path)).toMatchObject({scanned: 3, converted: 1, invalid: 1, cursor: 3});
    const row = db.query("SELECT embedding FROM message_vectors WHERE message_id='m2'").get() as {embedding: Uint8Array};
    expect(Array.from(decodeVector(row.embedding, 2))).toEqual([0, 1]);
    expect(db.query('SELECT COUNT(*) AS n FROM message_embeddings').get()).toEqual({n: 3});
    expect(await migrateVectorsInBackground(path)).toMatchObject({scanned: 0, converted: 0, invalid: 0, cursor: 3});
  } finally {cleanup();}
});

test('a progress callback failure releases the lease while retaining its committed cursor', async () => {
  const {path, db, cleanup} = setup(65);
  const reason = new Error('report failed');
  let reports = 0;
  let terminalState: string | undefined;
  try {
    await expect(migrateVectorsInBackground(path, {progress: report => {
      if (++reports === 1) throw reason;
      terminalState = report.lease?.state;
      throw new Error('secondary report failure');
    }}))
      .rejects.toBe(reason);
    expect(reports).toBe(2);
    expect(terminalState).toBe('released');
    expect(readBackfillLease(path)).toBeNull();
    expect(db.query('SELECT COUNT(*) AS n FROM message_vectors').get()).toEqual({n: 32});
    expect(await migrateVectorsInBackground(path)).toMatchObject({scanned: 33, converted: 33, cursor: 65});
  } finally {cleanup();}
});

test('lease loss fences the next page and release preserves the replacement owner', async () => {
  const {path, db, cleanup} = setup(65);
  const replacement: {lease: ReturnType<typeof acquireBackfillLock>} = {lease: null};
  const progress: VectorMigrationReport[] = [];
  let yields = 0;
  try {
    await expect(migrateVectorsInBackground(path, {progress: report => {progress.push(report);}, yield: async () => {
      if (++yields === 2) {
        db.run('UPDATE locks SET expires_at=0');
        replacement.lease = acquireBackfillLock(path);
        expect(replacement.lease).not.toBeNull();
      }
    }})).rejects.toThrow('backfill lease lost');
    expect(db.query('SELECT COUNT(*) AS n FROM message_vectors').get()).toEqual({n: 32});
    expect(db.query("SELECT cursor FROM vector_migration WHERE name='json-f32'").get()).toEqual({cursor: 32});
    expect(progress[0].lease?.state).toBe('held');
    expect(progress.at(-1)?.lease?.state).toBe('lost');
    replacement.lease!.assertOwned();
    expect(readBackfillLease(path)?.state).toBe('held');
  } finally {replacement.lease?.release(); cleanup();}
});

test('an already cancelled migration does not acquire a lease or advance its cursor', async () => {
  const {path, db, cleanup} = setup(1);
  const abort = new AbortController();
  abort.abort(new Error('already cancelled'));
  try {
    await expect(migrateVectorsInBackground(path, {signal: abort.signal})).rejects.toThrow('already cancelled');
    expect(readBackfillLease(path)).toBeNull();
    expect(db.query('SELECT * FROM vector_migration').all()).toEqual([]);
  } finally {cleanup();}
});

test('cancelling a busy lease wait interrupts a pending yield and leaves the holder untouched', async () => {
  const {path, db, cleanup} = setup(65);
  const holder = acquireBackfillLock(path)!;
  const abort = new AbortController();
  const reason = new Error('migration cancelled while locked');
  let entered!: () => void, resume!: () => void;
  const waiting = new Promise<void>(resolve => {entered = resolve;});
  const gate = new Promise<void>(resolve => {resume = resolve;});
  let yields = 0;
  const job = migrateVectorsInBackground(path, {signal: abort.signal, yield: async () => {
    if (++yields === 2) {entered(); await gate;}
  }}).then(() => null, error => error);
  try {
    await waiting;
    abort.abort(reason);
    expect(await Promise.race([job, Bun.sleep(100).then(() => 'still waiting')])).toBe(reason);
    holder.assertOwned();
    expect(db.query('SELECT COUNT(*) AS n FROM message_vectors').get()).toEqual({n: 0});
    expect(db.query('SELECT * FROM vector_migration').all()).toEqual([]);
  } finally {
    resume();
    await job;
    holder.release();
    cleanup();
  }
});

test('the busy lease retry timer is cancellable without waiting for its delay to expire', async () => {
  const {path, db, cleanup} = setup(1);
  const holder = acquireBackfillLock(path)!;
  const abort = new AbortController();
  const reason = new Error('retry stopped');
  let entered!: () => void, yields = 0;
  const waiting = new Promise<void>(resolve => {entered = resolve;});
  const job = migrateVectorsInBackground(path, {signal: abort.signal, yield: async () => {
    if (++yields === 2) entered();
  }}).then(() => null, error => error);
  try {
    await waiting;
    await Bun.sleep(10);
    abort.abort(reason);
    expect(await Promise.race([job, Bun.sleep(100).then(() => 'still waiting')])).toBe(reason);
    expect(db.query('SELECT * FROM vector_migration').all()).toEqual([]);
    holder.assertOwned();
  } finally {abort.abort(reason); await job; holder.release(); cleanup();}
});
