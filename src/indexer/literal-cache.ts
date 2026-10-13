import type {Database} from "bun:sqlite";
import {ensureMessageLookup} from "./message-lookup";
import {searchRevision} from "./search-revision";

interface Row {rowid:number;session_id:string;message_id:string;text:string;source:string;}
interface Cache {revision:number;changes:number;version:number;rows:Map<number,Row>;sessions:Map<string,Set<number>>;}
const caches=new WeakMap<Database,Cache>();
function stamp(db:Database) {
  return {revision:searchRevision(db),changes:(db.query("SELECT total_changes() AS n").get() as {n:number}).n,
    version:(db.query("PRAGMA data_version").get() as {data_version:number}).data_version};
}
function append(cache:Cache,rows:Iterable<Row>) {
  for(const row of rows) {
    cache.rows.set(row.rowid,row);
    let ids=cache.sessions.get(row.session_id);if(!ids)cache.sessions.set(row.session_id,ids=new Set());
    ids.add(row.rowid);
  }
}
/** Literal substring recall requires all text. Keep one SQLite-lowercase copy
 * per connection, shared across model switches; refresh only changed sessions. */
export function cachedSubstringCandidates(db:Database,literal:string,source:string|undefined,limit:number) {
  ensureMessageLookup(db);
  const state=stamp(db);let cache=caches.get(db);
  if(!cache || state.revision<cache.revision || cache.revision===state.revision && (cache.changes!==state.changes || cache.version!==state.version)) {
    cache={...state,rows:new Map(),sessions:new Map()};
    append(cache,db.query("SELECT rowid,session_id,message_id,lower(text) AS text,source FROM messages_fts ORDER BY rowid").iterate() as Iterable<Row>);
    caches.set(db,cache);
  } else if(cache.revision!==state.revision) {
    for(const {session_id} of db.query("SELECT session_id FROM search_changes WHERE revision>?").all(cache.revision) as Array<{session_id:string}>) {
      for(const id of cache.sessions.get(session_id) ?? [])cache.rows.delete(id);
      cache.sessions.delete(session_id);
      append(cache,db.query(`SELECT f.rowid,f.session_id,f.message_id,lower(f.text) AS text,f.source FROM message_lookup k
        JOIN messages_fts f ON f.rowid=k.fts_rowid AND f.session_id=k.session_id AND f.message_id=k.message_id WHERE k.session_id=? ORDER BY f.rowid`).iterate(session_id) as Iterable<Row>);
    }
  }
  Object.assign(cache,stamp(db));
  const read=db.query(`SELECT text,message_id,session_id,role,created_at,source,title FROM messages_fts
    WHERE rowid=? AND session_id=? AND message_id=? AND instr(lower(text),?)>0`);
  const hits:any[]=[],needle=literal.toLowerCase();
  for(const row of cache.rows.values()) {
    if(source && row.source!==source || !row.text.includes(needle))continue;
    const hit=read.get(row.rowid,row.session_id,row.message_id,needle) as {source:string}|null;
    if(!hit || source && hit.source!==source)continue;
    hits.push(hit);if(hits.length>=limit)break;
  }
  return hits;
}
