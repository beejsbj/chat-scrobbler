import {expect, test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openIndex, indexSession} from '../src/indexer/sqlite';
import {warmSearchCaches, searchWarmupStatus} from '../src/indexer/search-warmup';
import {fixture} from './support/embedding-fixture';
import {migrateVectorsInBackground} from '../src/indexer/background-vector-migration';
import {deferWalCheckpoints} from '../src/indexer/background-wal-checkpoint';

const autocheckpoint = (db: ReturnType<typeof openIndex>) =>
  (db.query('PRAGMA wal_autocheckpoint').get() as {wal_autocheckpoint: number}).wal_autocheckpoint;

test('warmup disables commit checkpoints across lookup and literal yields, then restores the caller setting', async () => {
  const root = mkdtempSync(join(tmpdir(), 'warmup-wal-'));
  const db = openIndex(join(root, 'index.db'));
  try {
    db.transaction(() => {
      for (let i = 0; i < 65; i++) db.run(
        'INSERT INTO messages_fts(session_id,message_id,text,source) VALUES (?,?,?,?)',
        ['chatgpt:test', String(i), 'archived words', 'chatgpt']);
    })();
    db.run('PRAGMA wal_autocheckpoint=7');
    const stages = new Set<string>();
    let yields = 0;
    await warmSearchCaches(db, null, {batchSize: 4, yield: async () => {
      expect(autocheckpoint(db)).toBe(0);
      stages.add(searchWarmupStatus(db).stage);
      yields++;
      await Bun.sleep(0);
    }});
    expect(yields).toBeGreaterThan(16);
    expect(stages.has('lookup')).toBe(true);
    expect(stages.has('literal')).toBe(true);
    expect(autocheckpoint(db)).toBe(7);
    expect(searchWarmupStatus(db).state).toBe('ready');
  } finally {
    db.close();
    rmSync(root, {recursive: true, force: true});
  }
});

test('competing worker checkpoints do not turn WAL contention into a failed warmup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'warmup-checkpoint-race-'));
  const path = join(root, 'index.db');
  const db = openIndex(path);
  try {
    db.run('PRAGMA wal_autocheckpoint=0');
    db.run('CREATE TABLE checkpoint_fixture(payload BLOB)');
    const wal = deferWalCheckpoints(db);
    try {
      for (let round = 0; round < 3; round++) {
        db.run('INSERT INTO checkpoint_fixture VALUES (zeroblob(5242880))');
        const outcomes = await Promise.allSettled([
          wal.checkpoint(), wal.checkpoint(), wal.checkpoint(), warmSearchCaches(db, null),
        ]);
        for (const outcome of outcomes) {
          expect(outcome.status).toBe('fulfilled');
        }
        expect(searchWarmupStatus(db).state).toBe('ready');
      }
    } finally {wal.restore();}
  } finally {db.close(); rmSync(root, {recursive: true, force: true});}
});

test('warmup remains ready when startup migration and checkpoints share the same WAL', async () => {
  const root = mkdtempSync(join(tmpdir(), 'warmup-concurrent-'));
  const path = join(root, 'index.db');
  const db = openIndex(path);
  try {
    db.run('PRAGMA wal_autocheckpoint=0');
    db.run('CREATE TABLE checkpoint_fixture(payload BLOB)');
    db.run('INSERT INTO checkpoint_fixture VALUES (zeroblob(5242880))');
    db.transaction(() => {
      for (let i = 0; i < 193; i++) {
        db.run('INSERT INTO messages_fts(session_id,message_id,text,source,title) VALUES (?,?,?,?,?)',
          ['chatgpt:test', String(i), 'stored words', 'chatgpt', 'T']);
        db.run(`INSERT INTO message_embeddings(session_id,message_id,embedding,text,title,provider_kind,provider_model,dimension)
          VALUES (?,?,?,?,?,?,?,?)`, ['chatgpt:test', String(i), '[1,0]', 'stored words', 'T', 'test', 'legacy', 2]);
      }
    })();
    const provider = {kind: 'test', model: 'legacy', dimensions: 2, embed: () => {throw new Error('unexpected inference');}};
    const outcomes = await Promise.allSettled([warmSearchCaches(db, provider), migrateVectorsInBackground(path)]);
    for (const outcome of outcomes) {
      // Deliberately omit errors/messages from this diagnostic's assertion output.
      expect(outcome.status).toBe('fulfilled');
    }
    expect(searchWarmupStatus(db).state).toBe('ready');
  } finally {db.close(); rmSync(root, {recursive: true, force: true});}
});

test('vector warmup keeps autocheckpoint disabled and uses persisted vectors without inference', async () => {
  const db = openIndex(':memory:');
  const provider = {kind: 'test', model: 'warmup-round4', dimensions: 2, embed: () => [1, 0]};
  try {
    const session = fixture();
    session.messages = Array.from({length: 13}, (_, i) => ({...session.messages[0], id: String(i)}));
    indexSession(db, session, {embeddingProvider: provider});
    const stages = new Set<string>();
    let calls = 0;
    db.run('PRAGMA wal_autocheckpoint=29');
    await warmSearchCaches(db, {...provider, embed: () => {calls++; throw new Error('unexpected inference');}}, {
      batchSize: 3, yield: async () => {
        expect(autocheckpoint(db)).toBe(0);
        stages.add(searchWarmupStatus(db).stage);
        await Bun.sleep(0);
      },
    });
    expect(stages.has('vectors')).toBe(true);
    expect(calls).toBe(0);
    expect(autocheckpoint(db)).toBe(29);
    expect(searchWarmupStatus(db).state).toBe('ready');
  } finally {db.close();}
});

test('warmup caps oversized lookup batches so startup still yields after at most 64 rows', async () => {
  const db = openIndex(':memory:');
  try {
    db.transaction(() => {
      for (let i = 0; i < 257; i++) db.run(
        'INSERT INTO messages_fts(session_id,message_id,text,source) VALUES (?,?,?,?)',
        ['chatgpt:test', String(i), 'stored words', 'chatgpt']);
    })();
    let previous = 0, largest = 0;
    await warmSearchCaches(db, null, {batchSize: 1024, yield: async () => {
      const {cursor} = db.query('SELECT cursor FROM message_lookup_state WHERE id=1').get() as {cursor: number};
      largest = Math.max(largest, cursor - previous);
      previous = cursor;
    }});
    expect(largest).toBeGreaterThan(0);
    expect(largest).toBeLessThanOrEqual(64);
  } finally {db.close();}
});

test('warmup restores autocheckpoint after yield failure and cancellation, including an already aborted signal', async () => {
  for (const failure of ['yield', 'cancel', 'already-aborted']) {
    const db = openIndex(':memory:');
    const abort = new AbortController();
    const reason = new Error(failure);
    try {
      db.run('PRAGMA wal_autocheckpoint=23');
      if (failure === 'already-aborted') abort.abort(reason);
      await expect(warmSearchCaches(db, null, {signal: abort.signal, yield: async () => {
        expect(autocheckpoint(db)).toBe(0);
        if (failure === 'yield') throw reason;
        abort.abort(reason);
      }})).rejects.toThrow(failure);
      expect(autocheckpoint(db)).toBe(23);
      expect(searchWarmupStatus(db).state).toBe('failed');
      // A failed job must release its deduplication slot, too.
      await warmSearchCaches(db, null);
      expect(searchWarmupStatus(db).state).toBe('ready');
      expect(autocheckpoint(db)).toBe(23);
    } finally {db.close();}
  }
});

test('failed warmup records only a sanitized error name, SQLite code and stage', async () => {
  const db = openIndex(':memory:');
  const failure = Object.assign(new Error('private chat text must never be logged'), {code: 'SQLITE_BUSY'});
  try {
    await expect(warmSearchCaches(db, null, {yield: async () => {throw failure;}})).rejects.toBe(failure);
    expect(searchWarmupStatus(db)).toMatchObject({state: 'failed', failure: {name: 'Error', code: 'SQLITE_BUSY', stage: 'lookup'}});
    expect(JSON.stringify(searchWarmupStatus(db))).not.toContain('private chat text');
  } finally {db.close();}
});

test('cancelling a pending warmup yield restores the checkpoint policy before the yield resumes', async () => {
  const db = openIndex(':memory:');
  const abort = new AbortController();
  const reason = new Error('warmup stopped');
  let entered!: () => void, resume!: () => void;
  const waiting = new Promise<void>(resolve => {entered = resolve;});
  const gate = new Promise<void>(resolve => {resume = resolve;});
  db.run('PRAGMA wal_autocheckpoint=31');
  const job = warmSearchCaches(db, null, {signal: abort.signal, yield: async () => {
    entered(); await gate;
  }}).then(() => null, error => error);
  try {
    await waiting;
    abort.abort(reason);
    expect(await Promise.race([job, Bun.sleep(100).then(() => 'still waiting')])).toBe(reason);
    expect(autocheckpoint(db)).toBe(31);
    expect(searchWarmupStatus(db).state).toBe('failed');
  } finally {resume(); await job; db.close();}
});

test('warmup checkpoints a large WAL between batches while keeping the request loop live', async () => {
  const root = mkdtempSync(join(tmpdir(), 'warmup-wal-bound-'));
  const path = join(root, 'index.db');
  const db = openIndex(path);
  try {
    db.run('PRAGMA wal_autocheckpoint=0');
    db.run('INSERT INTO messages_fts(session_id,message_id,text,source) VALUES (?,?,?,?)',
      ['chatgpt:test', 'm', 'stored words', 'chatgpt']);
    // A disposable, already committed WAL backlog, without a large chat scan.
    db.run('CREATE TABLE checkpoint_fixture(payload BLOB)');
    db.run('INSERT INTO checkpoint_fixture VALUES (zeroblob(5242880))');
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(4 * 1024 * 1024);
    db.run('PRAGMA wal_autocheckpoint=13');
    let ticks = 0;
    const timer = setInterval(() => {ticks++;}, 1);
    try {
      await warmSearchCaches(db, null, {batchSize: 1, yield: async () => {
        expect(autocheckpoint(db)).toBe(0);
        await Bun.sleep(0);
      }});
    } finally {clearInterval(timer);}
    expect(ticks).toBeGreaterThan(0);
    expect(statSync(`${path}-wal`).size).toBeLessThan(4 * 1024 * 1024);
    expect(autocheckpoint(db)).toBe(13);
    expect(db.query('SELECT length(payload) AS n FROM checkpoint_fixture').get()).toEqual({n: 5242880});
  } finally {
    db.close();
    rmSync(root, {recursive: true, force: true});
  }
});

test('a pinned reader makes the WAL target soft without blocking warmup or losing data', async () => {
  const root = mkdtempSync(join(tmpdir(), 'warmup-reader-'));
  const path = join(root, 'index.db');
  const db = openIndex(path);
  const reader = new Database(path, {readonly: true});
  try {
    db.run('CREATE TABLE checkpoint_fixture(payload BLOB)');
    db.run('PRAGMA wal_checkpoint(TRUNCATE)');
    reader.run('BEGIN');
    reader.query('SELECT * FROM checkpoint_fixture').all();
    db.run('PRAGMA wal_autocheckpoint=0');
    db.run('INSERT INTO checkpoint_fixture VALUES (zeroblob(5242880))');
    db.run('PRAGMA wal_autocheckpoint=19');
    await warmSearchCaches(db, null);
    expect(searchWarmupStatus(db).state).toBe('ready');
    expect(autocheckpoint(db)).toBe(19);
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(4 * 1024 * 1024);
    reader.run('COMMIT');
    await warmSearchCaches(db, null);
    expect(statSync(`${path}-wal`).size).toBeLessThan(4 * 1024 * 1024);
    expect(autocheckpoint(db)).toBe(19);
  } finally {
    reader.close();
    db.close();
    rmSync(root, {recursive: true, force: true});
  }
});

test('warmup yields while another writer is held instead of blocking its release timer',async()=> {
 const root=mkdtempSync(join(tmpdir(),'warmup-writer-wait-')),path=join(root,'index.db');
 const db=openIndex(path),writer=openIndex(path);let timer:ReturnType<typeof setTimeout>|undefined;
 try {
  indexSession(db,fixture());writer.run('BEGIN IMMEDIATE');
  timer=setTimeout(()=>{timer=undefined;writer.run('COMMIT');},20);
  await warmSearchCaches(db,null);
  expect(searchWarmupStatus(db).state).toBe('ready');
  expect((db.query('PRAGMA busy_timeout').get() as {timeout:number}).timeout).toBe(5000);
 }finally{clearTimeout(timer);writer.close();db.close();rmSync(root,{recursive:true,force:true});}
});
