import type {Database} from 'bun:sqlite';
import type {Session} from '../schema/types';
import type {EmbeddingProvider} from './sqlite';
import {reusableTextVector,reusableBinaryTextVector,putTextVector,vectorScope,decodeVector,textVectorHash} from './vector-store';
import {failureRetry,type EmbeddingFailure} from './embedding-failures';

export interface PendingEmbeddingRow {
 session_id:string;message_id:string;provider_kind:string;provider_model:string;input_hash:string;title:string|null;
 fts_rowid:number;type:'text'|'image'|'audio'|'video';state:string;attempts:number;retry_at:number;
 reason:string|null;
 rowid:number;text:string;role:string;created_at:string|null;source:string;
}
export function createPendingTables(db:Database) {
 db.run(`CREATE TABLE IF NOT EXISTS embedding_models(provider_kind TEXT NOT NULL,provider_model TEXT NOT NULL,
   cursor INTEGER NOT NULL DEFAULT 0,seeded INTEGER NOT NULL DEFAULT 0,media INTEGER NOT NULL DEFAULT 0,
   asset_cursor TEXT NOT NULL DEFAULT '',PRIMARY KEY(provider_kind,provider_model))`);
 db.run(`CREATE TABLE IF NOT EXISTS embedding_pending(session_id TEXT NOT NULL,message_id TEXT NOT NULL,
   provider_kind TEXT NOT NULL,provider_model TEXT NOT NULL,input_hash TEXT NOT NULL,title TEXT,fts_rowid INTEGER NOT NULL,
   type TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0,
   priority TEXT NOT NULL,reason TEXT,truncated INTEGER NOT NULL DEFAULT 0,input_chars INTEGER NOT NULL DEFAULT 0,input_bytes INTEGER NOT NULL DEFAULT 0,
   PRIMARY KEY(session_id,message_id,provider_kind,provider_model))`);
 db.transaction(()=> {
  const columns=db.query('PRAGMA table_info(embedding_pending)').all() as Array<{name:string}>;
  const missing=['input_chars','input_bytes'].filter(column=>!columns.some(row=>row.name===column));
  for(const column of missing)db.run(`ALTER TABLE embedding_pending ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
  // Publish the schema and rescan requirement together, including after a crash.
  if(missing.length)db.run('UPDATE embedding_models SET cursor=0,seeded=0');
 }).immediate();
 db.run(`CREATE INDEX IF NOT EXISTS embedding_pending_due_v2 ON embedding_pending(provider_kind,provider_model,priority DESC,fts_rowid DESC)
   WHERE state IN ('pending','deferred')`);
 db.run('CREATE INDEX IF NOT EXISTS embedding_pending_coverage_v2 ON embedding_pending(provider_kind,provider_model,type,state,reason)');
}
export function createPendingVectorTriggers(db:Database) {
 for(const event of ['INSERT','UPDATE'])db.run(`CREATE TRIGGER IF NOT EXISTS pending_vector_${event.toLowerCase()}
 AFTER ${event} ON message_vectors BEGIN UPDATE embedding_pending SET state='complete',attempts=0,retry_at=0,reason=NULL
 WHERE session_id=NEW.session_id AND message_id=NEW.message_id AND provider_kind=NEW.provider_kind
 AND provider_model=NEW.provider_model AND input_hash=NEW.text_hash AND title IS NEW.title; END`);
 for(const event of ['INSERT','UPDATE']) {
 db.run(`DROP TRIGGER IF EXISTS pending_legacy_${event.toLowerCase()}`);
 db.run(`CREATE TRIGGER pending_legacy_${event.toLowerCase()}
 AFTER ${event} ON message_embeddings WHEN json_valid(NEW.embedding) AND json_array_length(NEW.embedding)=NEW.dimension BEGIN
 UPDATE embedding_pending SET state='complete',attempts=0,retry_at=0,reason=NULL WHERE session_id=NEW.session_id
 AND message_id=NEW.message_id AND provider_kind=NEW.provider_kind AND provider_model=COALESCE(NEW.provider_model,'')
 AND COALESCE(reason,'')!='chunk_set_rebuild' AND title IS NEW.title AND NEW.text=(SELECT f.text FROM messages_fts f WHERE f.rowid=fts_rowid
 AND f.session_id=embedding_pending.session_id AND f.message_id=embedding_pending.message_id); END`);
 }
 db.run(`CREATE TRIGGER IF NOT EXISTS pending_vector_delete AFTER DELETE ON message_vectors BEGIN
 UPDATE embedding_pending SET state='pending',retry_at=0 WHERE session_id=OLD.session_id AND message_id=OLD.message_id
 AND provider_kind=OLD.provider_kind AND provider_model=OLD.provider_model AND state='complete'; END`);
}
function scope(provider:EmbeddingProvider) {
 if(!provider.kind || !provider.model)throw new Error('pending work requires an explicit provider and model');
 return [provider.kind.trim(),provider.model.trim()] as const;
}
function upsertText(db:Database,row:any,kind:string,model:string,state='pending') {
 const hash=textVectorHash(row.text),blank=!row.text.trim();
 db.run(`INSERT INTO embedding_pending(session_id,message_id,provider_kind,provider_model,input_hash,title,fts_rowid,type,state,priority,reason,input_chars,input_bytes)
 VALUES (?,?,?,?,?,?,?,'text',?,?,?,?,?) ON CONFLICT(session_id,message_id,provider_kind,provider_model) DO UPDATE SET
 fts_rowid=excluded.fts_rowid,priority=excluded.priority,input_hash=excluded.input_hash,title=excluded.title,
 input_chars=excluded.input_chars,input_bytes=excluded.input_bytes,
 state=CASE WHEN embedding_pending.input_hash=excluded.input_hash AND embedding_pending.title IS excluded.title
   THEN embedding_pending.state ELSE excluded.state END,
 attempts=CASE WHEN embedding_pending.input_hash=excluded.input_hash AND embedding_pending.title IS excluded.title THEN embedding_pending.attempts ELSE 0 END,
 retry_at=CASE WHEN embedding_pending.input_hash=excluded.input_hash AND embedding_pending.title IS excluded.title THEN embedding_pending.retry_at ELSE 0 END,
 reason=CASE WHEN embedding_pending.input_hash=excluded.input_hash AND embedding_pending.title IS excluded.title THEN embedding_pending.reason ELSE excluded.reason END,
 truncated=CASE WHEN embedding_pending.input_hash=excluded.input_hash AND embedding_pending.title IS excluded.title THEN embedding_pending.truncated ELSE 0 END`,
 [row.session_id,row.message_id,kind,model,hash,row.title ?? null,row.rowid,blank ? 'skipped' : state,
 row.created_at ?? row.updated_at ?? '',blank ? 'empty_text' : null,row.text.length,Buffer.byteLength(row.text)]);
}
export function markPendingSession(db:Database,session:Session) {
 const models=db.query('SELECT provider_kind,provider_model,media FROM embedding_models').all() as Array<{provider_kind:string;provider_model:string;media:number}>;
 for(const model of models) {
  for(const row of db.query(`SELECT f.rowid,f.*,s.updated_at FROM message_lookup k JOIN messages_fts f ON f.rowid=k.fts_rowid
    JOIN sessions s ON s.id=k.session_id WHERE k.session_id=?`).all(session.id) as any[]) {
   const current=db.query(`SELECT 1 FROM message_vectors WHERE session_id=? AND message_id=? AND provider_kind=? AND provider_model=?
    AND text_hash=? AND title IS ? AND length(embedding)=dimension*4`).get(row.session_id,row.message_id,model.provider_kind,model.provider_model,textVectorHash(row.text),row.title)
    ?? db.query(`SELECT 1 FROM message_embeddings WHERE session_id=? AND message_id=? AND provider_kind=? AND provider_model IS ?
      AND text=? AND title IS ?`).get(row.session_id,row.message_id,model.provider_kind,model.provider_model,row.text,row.title);
   upsertText(db,row,model.provider_kind,model.provider_model,current ? 'complete' : 'pending');
  }
  if(model.media) seedAssets(db,model.provider_kind,model.provider_model,session.id);
 }
}
function seedAssets(db:Database,kind:string,model:string,session?:string) {
 const rows=db.query(`SELECT sha256,media_type,MAX(created_at) AS priority FROM asset_embedding_links ${session ? 'WHERE session_id=?' : ''} GROUP BY sha256`)
  .all(...(session ? [session] : [])) as Array<{sha256:string;media_type:string;priority:string|null}>;
 for(const row of rows) {
  const vector=db.query('SELECT embedding,dimension FROM asset_vectors WHERE sha256=? AND provider_kind=? AND provider_model=?')
   .get(row.sha256,kind,model) as {embedding:Uint8Array;dimension:number}|null;
  let complete=false;if(vector) {try{decodeVector(vector.embedding,vector.dimension);complete=true;}catch{}}

  db.run(`INSERT OR IGNORE INTO embedding_pending(session_id,message_id,provider_kind,provider_model,input_hash,fts_rowid,type,state,priority)
    VALUES ('',?,?,?,?,0,?,?,?)`,[row.sha256,kind,model,row.sha256,row.media_type,complete ? 'complete' : 'pending',row.priority ?? '']);
 }
}
/** Initial registration scans once, in yielding pages. Subsequent runs use the
 * partial pending index; captures maintain the markers in their transaction. */
export async function initializePendingEmbeddings(db:Database,provider:EmbeddingProvider,opts:{signal?:AbortSignal;yield?:()=>Promise<void>;batchSize?:number;assertLease?:()=>void}={}) {
 const [kind,model]=scope(provider),batch=opts.batchSize ?? 64;
 db.run('INSERT OR IGNORE INTO embedding_models(provider_kind,provider_model,media) VALUES (?,?,?)',[kind,model,provider.embedAsset ? 1 : 0]);
 while(true) {
  opts.signal?.throwIfAborted();
  const done=db.transaction(()=> {
   opts.assertLease?.();
   const state=db.query('SELECT cursor,seeded FROM embedding_models WHERE provider_kind=? AND provider_model=?').get(kind,model) as {cursor:number;seeded:number};
   if(state.seeded)return true;
   const rows=db.query('SELECT f.rowid,f.*,s.updated_at FROM messages_fts f LEFT JOIN sessions s ON s.id=f.session_id WHERE f.rowid>? ORDER BY f.rowid LIMIT ?').all(state.cursor,batch) as any[];
   for(const row of rows) {
    const binary=row.text.trim() && reusableBinaryTextVector(db,row.session_id,row.message_id,row.text,row.title ?? null,provider);
    const rebuild=!!row.text.trim() && !binary && !!db.query(`SELECT 1 FROM message_vector_chunks
      WHERE session_id=? AND message_id=? AND provider_kind=? AND provider_model=? AND (? IS NULL OR dimension=?) LIMIT 1`)
      .get(row.session_id,row.message_id,kind,model,provider.dimensions ?? null,provider.dimensions ?? null);
    const current=binary || !rebuild && row.text.trim() && reusableTextVector(db,row.session_id,row.message_id,row.text,row.title ?? null,provider);
    // Repair a corrupt binary snapshot from matching legacy data as CPU-only
    // maintenance. Unconverted legacy rows remain outside the inference budget.
    if(current && db.query('SELECT 1 FROM message_vectors WHERE session_id=? AND message_id=? AND provider_kind=? AND provider_model=?')
      .get(row.session_id,row.message_id,kind,model) && !binary)
      putTextVector(db,{...row,...vectorScope(provider,current.length),embedding:current});
    upsertText(db,row,kind,model,current ? 'complete' : 'pending');
    if(rebuild)db.run(`UPDATE embedding_pending SET state='pending',attempts=0,retry_at=0,truncated=0,reason='chunk_set_rebuild'
      WHERE session_id=? AND message_id=? AND provider_kind=? AND provider_model=?`,[row.session_id,row.message_id,kind,model]);
   }
   if(rows.length<batch && provider.embedAsset)seedAssets(db,kind,model);
   db.run('UPDATE embedding_models SET cursor=?,seeded=? WHERE provider_kind=? AND provider_model=?',
    [rows.at(-1)?.rowid ?? state.cursor,rows.length<batch ? 1 : 0,kind,model]);
   opts.assertLease?.();return rows.length<batch;
  }).immediate();
  if(done)return;
  await (opts.yield?.() ?? Bun.sleep(0));
 }
}
export function pendingEmbeddingRows(db:Database,provider:EmbeddingProvider,limit:number,now=Date.now()):PendingEmbeddingRow[] {
 const [kind,model]=scope(provider);
 const rows=db.query(`SELECT * FROM embedding_pending WHERE provider_kind=? AND provider_model=?
   AND state IN ('pending','deferred') AND retry_at<=? ORDER BY priority DESC,fts_rowid DESC LIMIT ?`).all(kind,model,now,limit) as PendingEmbeddingRow[];
 return rows.map(row=> {
  if(row.type!=='text')return row;
  const live=db.query('SELECT rowid,* FROM messages_fts WHERE rowid=? AND session_id=? AND message_id=?').get(row.fts_rowid,row.session_id,row.message_id) as any;
  return live ? {...row,...live} : row;
 });
}
export function pendingCoverage(db:Database,provider:EmbeddingProvider) {
 const [kind,model]=scope(provider);
 const rows=db.query(`SELECT state,reason,COUNT(*) AS n FROM embedding_pending WHERE provider_kind=? AND provider_model=? AND type='text' GROUP BY state,reason`)
  .all(kind,model) as Array<{state:string;reason:string|null;n:number}>;
 const count=(state:string)=>rows.filter(row=>row.state===state).reduce((n,row)=>n+row.n,0);
 return {total:rows.filter(row=>row.reason!=='empty_text').reduce((n,row)=>n+row.n,0),embedded:count('complete'),
  pending:count('pending'),deferred:count('deferred'),skipped:count('skipped'),empty:rows.filter(row=>row.reason==='empty_text').reduce((n,row)=>n+row.n,0)};
}
export function completePendingEmbedding(db:Database,row:PendingEmbeddingRow,truncated=false) {
 db.run(`UPDATE embedding_pending SET state='complete',attempts=0,retry_at=0,truncated=?,reason=?
  WHERE session_id=? AND message_id=? AND provider_kind=? AND provider_model=? AND input_hash=? AND title IS ? AND fts_rowid=?`,
 [truncated ? 1 : 0,truncated ? 'chunk_limit_truncated' : null,row.session_id,row.message_id,row.provider_kind,row.provider_model,row.input_hash,row.title,row.fts_rowid]);
}
export function deferPendingEmbedding(db:Database,row:PendingEmbeddingRow,failure:EmbeddingFailure,now:number) {
 const current=db.query(`SELECT attempts FROM embedding_pending WHERE session_id=? AND message_id=? AND provider_kind=? AND provider_model=? AND input_hash=? AND title IS ? AND fts_rowid=?
  AND state IN ('pending','deferred')`)
  .get(row.session_id,row.message_id,row.provider_kind,row.provider_model,row.input_hash,row.title,row.fts_rowid) as {attempts:number}|null;
 if(!current)return null;
 const retry=failureRetry(failure.kind,current.attempts+1,now,failure.reason);
 const result=db.query(`UPDATE embedding_pending SET state=?,attempts=attempts+1,retry_at=?,reason=?
  WHERE session_id=? AND message_id=? AND provider_kind=? AND provider_model=? AND input_hash=? AND title IS ? AND fts_rowid=?
  AND state IN ('pending','deferred') RETURNING attempts,state,retry_at,reason`)
 .get(retry.state,retry.retry_at,retry.reason,row.session_id,row.message_id,row.provider_kind,row.provider_model,row.input_hash,row.title,row.fts_rowid) as {attempts:number;state:string;retry_at:number;reason:string}|null;
 return result;
}

/** Estimate from small pending records; no archived text/blob decoding on CLI passes. */
export function pendingWorkEstimate(db:Database,provider:EmbeddingProvider):number {
 const [kind,model]=scope(provider),room=provider.chunkChars ?? (kind==='embeddinggemma' ? 1200 : 1500),cap=provider.maxChunks ?? 16;
 const bytes=kind==='embeddinggemma' ? 'MAX((input_chars+?-1)/?,(input_bytes+1199)/1200)' : '(input_chars+?-1)/?';
 return (db.query(`SELECT COALESCE(SUM(CASE WHEN type='text' THEN MIN(?,MAX(1,${bytes})) ELSE 1 END),0) AS n
  FROM embedding_pending WHERE provider_kind=? AND provider_model=? AND state IN ('pending','deferred')`)
  .get(cap,room,room,kind,model) as {n:number}).n;
}
