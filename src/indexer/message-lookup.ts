import type { Database } from "bun:sqlite";

/** FTS5 metadata columns cannot be indexed. This small identity-to-rowid map
 * lets vector scans validate freshness through FTS5's indexed rowid lookup. */
export function createMessageLookup(db: Database): void {
  if (db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='message_lookup'").get()) return;
  db.transaction(() => {
    db.run(`CREATE TABLE IF NOT EXISTS message_lookup(session_id TEXT NOT NULL,message_id TEXT NOT NULL,
      fts_rowid INTEGER NOT NULL,PRIMARY KEY(session_id,message_id))`);
    db.run("INSERT OR REPLACE INTO message_lookup SELECT session_id,message_id,rowid FROM messages_fts");
  })();
}
