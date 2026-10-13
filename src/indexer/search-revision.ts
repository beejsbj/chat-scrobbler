import type { Database } from "bun:sqlite";

// Triggers run even when an older executable writes to this index. Coalesce
// changes by session so refreshing one message never reloads the whole matrix.
export function createSearchRevision(db: Database): void {
  db.run("CREATE TABLE IF NOT EXISTS search_revision(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL)");
  db.run("INSERT OR IGNORE INTO search_revision VALUES (1,0)");
  db.run("CREATE TABLE IF NOT EXISTS search_changes(session_id TEXT PRIMARY KEY,revision INTEGER NOT NULL)");
  for(const table of ["sessions","message_vectors","message_embeddings"])
    for(const event of ["INSERT","UPDATE","DELETE"]) {
      const reference=event==="DELETE" ? "OLD" : "NEW";
      const key=table==="sessions" ? "id" : "session_id";
      db.run(`CREATE TRIGGER IF NOT EXISTS search_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN
        UPDATE search_revision SET revision=revision+1 WHERE id=1;
        INSERT OR REPLACE INTO search_changes SELECT ${reference}.${key},revision FROM search_revision WHERE id=1;
      END`);
    }
}
export function searchRevision(db: Database): number {
  return (db.query("SELECT revision FROM search_revision WHERE id=1").get() as {revision:number}).revision;
}
