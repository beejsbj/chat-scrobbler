import type { Database } from "bun:sqlite";

/** FTS5 metadata columns cannot be indexed. This small identity-to-rowid map
 * lets vector scans validate freshness through FTS5's indexed rowid lookup. */
export function createMessageLookup(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS message_lookup(session_id TEXT NOT NULL,message_id TEXT NOT NULL,
    fts_rowid INTEGER NOT NULL,PRIMARY KEY(session_id,message_id))`);
  db.run("CREATE TABLE IF NOT EXISTS message_lookup_state(id INTEGER PRIMARY KEY,cursor INTEGER NOT NULL,ready INTEGER NOT NULL)");
  // Rebuild even an existing map once: older binaries never maintained it.
  db.run("INSERT OR IGNORE INTO message_lookup_state VALUES (1,0,0)");
  db.run("CREATE TABLE IF NOT EXISTS message_lookup_dirty(session_id TEXT PRIMARY KEY)");
  for(const [event,reference] of [["INSERT","NEW"],["UPDATE","NEW"],["DELETE","OLD"]])
    db.run(`CREATE TRIGGER IF NOT EXISTS lookup_session_${event.toLowerCase()} AFTER ${event} ON sessions BEGIN
      INSERT OR IGNORE INTO message_lookup_dirty VALUES (${reference}.id); END`);
}

/** Build on demand in bounded transactions, never while opening the database.
 * Session triggers also run in rollback binaries, leaving a durable catch-up marker. */
export function ensureMessageLookup(db: Database): void {
  let state=db.query("SELECT cursor,ready FROM message_lookup_state WHERE id=1").get() as {cursor:number;ready:number};
  while(!state.ready) {
    state=db.transaction(()=> {
      const rows=db.query("SELECT rowid,session_id,message_id FROM messages_fts WHERE rowid>? ORDER BY rowid LIMIT 500").all(state.cursor) as Array<{rowid:number;session_id:string;message_id:string}>;
      for(const row of rows) db.run("INSERT OR REPLACE INTO message_lookup VALUES (?,?,?)",[row.session_id,row.message_id,row.rowid]);
      const next={cursor:rows.at(-1)?.rowid ?? state.cursor,ready:rows.length<500 ? 1 : 0};
      db.run("UPDATE message_lookup_state SET cursor=?,ready=? WHERE id=1",[next.cursor,next.ready]);
      return next;
    })();
  }
  for(const {session_id} of db.query("SELECT session_id FROM message_lookup_dirty").all() as Array<{session_id:string}>) db.transaction(()=> {
    db.run("DELETE FROM message_lookup WHERE session_id=?",[session_id]);
    db.run("INSERT OR REPLACE INTO message_lookup SELECT session_id,message_id,rowid FROM messages_fts WHERE session_id=?",[session_id]);
    db.run("DELETE FROM message_lookup_dirty WHERE session_id=?",[session_id]);
  })();
}
