import {expect, spyOn, test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openIndex} from '../src/indexer/sqlite';
import {messageLookupBatch} from '../src/indexer/message-lookup';

test('a nonzero lookup page reserves the WAL writer before reading, preventing a stale snapshot upgrade', () => {
  const root = mkdtempSync(join(tmpdir(), 'lookup-wal-snapshot-'));
  const path = join(root, 'index.db');
  const db = openIndex(path);
  const writer = new Database(path);
  let restore: (() => void) | undefined;
  try {
    db.run('PRAGMA busy_timeout=0');
    writer.run('PRAGMA busy_timeout=0');
    db.run('CREATE TABLE competing_commits(value INTEGER)');
    for (let i = 0; i < 3; i++) db.run(
      'INSERT INTO messages_fts(session_id,message_id,text,source) VALUES (?,?,?,?)',
      ['chatgpt:test', String(i), 'synthetic words', 'chatgpt']);
    expect(messageLookupBatch(db, 1)).toBe(false);
    expect(db.query('SELECT cursor,ready FROM message_lookup_state WHERE id=1').get())
      .toEqual({cursor: 1, ready: 0});

    const statement = db.query('SELECT rowid,session_id,message_id FROM messages_fts WHERE rowid>? ORDER BY rowid LIMIT ?');
    const read = statement.all.bind(statement);
    let competing: 'committed' | 'blocked' | undefined;
    const intercept = spyOn(statement, 'all').mockImplementation((...args) => {
      const rows = read(...args);
      // Commit after the page's read snapshot, before its first lookup write.
      // A deferred transaction permits this and then fails with BUSY_SNAPSHOT.
      try {writer.run('INSERT INTO competing_commits VALUES (1)'); competing = 'committed';}
      catch (error) {expect(error).toMatchObject({code: 'SQLITE_BUSY'}); competing = 'blocked';}
      return rows;
    });
    restore = () => intercept.mockRestore();

    expect(messageLookupBatch(db, 1)).toBe(false);
    expect(competing).toBe('blocked');
    expect(db.query('SELECT cursor,ready FROM message_lookup_state WHERE id=1').get())
      .toEqual({cursor: 2, ready: 0});
    restore(); restore = undefined;
    // The reservation lasts one page; another writer can commit between pages.
    writer.run('INSERT INTO competing_commits VALUES (1)');
    while (!messageLookupBatch(db, 1)) {}
    expect(db.query('SELECT COUNT(*) AS n FROM message_lookup').get()).toEqual({n: 3});
    expect(db.query('SELECT COUNT(*) AS n FROM competing_commits').get()).toEqual({n: 1});
  } finally {
    restore?.(); writer.close(); db.close();
    rmSync(root, {recursive: true, force: true});
  }
});
