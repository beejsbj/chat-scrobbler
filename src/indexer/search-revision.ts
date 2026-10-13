import type { Database } from "bun:sqlite";
import type { VectorScope } from "./vector-store";

// Session edits affect every model and literal cache. Vector edits affect just
// their model set. Triggers also run in executables from before this upgrade.
export function createSearchRevision(db: Database): void {
  db.transaction(()=> {
  db.run("CREATE TABLE IF NOT EXISTS search_revision(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL)");
  db.run("INSERT OR IGNORE INTO search_revision VALUES (1,0)");
  db.run("CREATE TABLE IF NOT EXISTS search_changes(session_id TEXT PRIMARY KEY,revision INTEGER NOT NULL)");
  const upgraded=!!db.query("SELECT 1 FROM sqlite_master WHERE name='search_vector_changes'").get();
  db.run(`CREATE TABLE IF NOT EXISTS search_model_changes(session_id TEXT NOT NULL,provider_kind TEXT NOT NULL,
    provider_model TEXT NOT NULL,dimension INTEGER NOT NULL,revision INTEGER NOT NULL,
    PRIMARY KEY(session_id,provider_kind,provider_model,dimension))`);
  db.run(`CREATE TABLE IF NOT EXISTS search_vector_changes(session_id TEXT NOT NULL,message_id TEXT NOT NULL,
    provider_kind TEXT NOT NULL,provider_model TEXT NOT NULL,dimension INTEGER NOT NULL,revision INTEGER NOT NULL,
    PRIMARY KEY(session_id,message_id,provider_kind,provider_model,dimension))`);
  db.run("CREATE INDEX IF NOT EXISTS search_vector_scope ON search_vector_changes(provider_kind,provider_model,dimension,revision)");
  db.run("CREATE INDEX IF NOT EXISTS search_model_scope ON search_model_changes(provider_kind,provider_model,dimension,revision)");
  db.run("CREATE INDEX IF NOT EXISTS search_session_revision ON search_changes(revision)");
  if(!upgraded) for(const table of ["sessions","message_vectors","message_embeddings"])
    for(const event of ["insert","update","delete"])db.run(`DROP TRIGGER IF EXISTS search_${table}_${event}`);
  for(const table of ["sessions","message_vectors","message_embeddings"])
    for(const event of ["INSERT","UPDATE","DELETE"]) {
      const refs=event==="UPDATE" ? ["OLD","NEW"] : [event==="DELETE" ? "OLD" : "NEW"];
      const marks=refs.map(ref=>table==="sessions"
        ? `INSERT OR REPLACE INTO search_changes SELECT ${ref}.id,revision FROM search_revision WHERE id=1;`
        : `INSERT OR REPLACE INTO search_model_changes SELECT ${ref}.session_id,COALESCE(${ref}.provider_kind,'unknown'),
          COALESCE(${ref}.provider_model,''),COALESCE(${ref}.dimension,0),revision FROM search_revision WHERE id=1;
          INSERT OR REPLACE INTO search_vector_changes SELECT ${ref}.session_id,${ref}.message_id,COALESCE(${ref}.provider_kind,'unknown'),
          COALESCE(${ref}.provider_model,''),COALESCE(${ref}.dimension,0),revision FROM search_revision WHERE id=1;`).join("\n");
      db.run(`CREATE TRIGGER IF NOT EXISTS search_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN
        UPDATE search_revision SET revision=revision+1 WHERE id=1;
        ${marks}
      END`);
    }
  // Asset ranking currently streams its own set. Track these commits so a
  // text cache does not mistake them for untracked FTS edits and rebuild.
  for(const event of ["INSERT","UPDATE","DELETE"])
    db.run(`CREATE TRIGGER IF NOT EXISTS search_asset_vectors_${event.toLowerCase()} AFTER ${event} ON asset_vectors BEGIN
      UPDATE search_revision SET revision=revision+1 WHERE id=1; END`);
  })();
}
export function searchRevision(db: Database): number {
  return (db.query("SELECT revision FROM search_revision WHERE id=1").get() as {revision:number}).revision;
}
export function changedSearchSessions(db:Database,revision:number,scope?:VectorScope): Set<string> {
  const rows=db.query("SELECT session_id FROM search_changes WHERE revision>?").all(revision) as Array<{session_id:string}>;
  if(scope)rows.push(...db.query(`SELECT session_id FROM search_model_changes WHERE revision>?
    AND provider_kind=? AND provider_model=? AND dimension=?`).all(revision,scope.provider_kind,scope.provider_model,scope.dimension) as Array<{session_id:string}>);
  return new Set(rows.map(row=>row.session_id));
}

export function changedSearchVectors(db:Database,revision:number,scope:VectorScope) {
  return db.query(`SELECT session_id,message_id FROM search_vector_changes WHERE revision>?
    AND provider_kind=? AND provider_model=? AND dimension=?`)
    .all(revision,scope.provider_kind,scope.provider_model,scope.dimension) as Array<{session_id:string;message_id:string}>;
}
