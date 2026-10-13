import type {WarmupOptions} from "./search-warmup";
import type { Database } from "bun:sqlite";
import { ensureMessageLookup } from "./message-lookup";
import { searchRevision, changedSearchSessions, changedSearchVectors } from "./search-revision";
import { decodeVector, textVectorHash, type VectorScope } from "./vector-store";

interface Entry { session_id:string; message_id:string; rowid:number; source:string; hash:string;title:string|null; }
interface Cache {
  builds:number; scope:string; revision:number; changes:number; dataVersion:number; dimension:number;
  session_refreshes:number; message_refreshes:number; matrix:Float32Array; entries:Array<Entry|null>; identities:Map<string,number>; free:number[];
}
const active=new WeakMap<Database,Cache>();
const builds=new WeakMap<Database,number>();
const identity=(s:string,m:string)=>`${s}\0${m}`;
const counters=(db:Database)=>({changes:(db.query("SELECT total_changes() AS n").get() as {n:number}).n,
  dataVersion:(db.query("PRAGMA data_version").get() as {data_version:number}).data_version});

function vectorRows(db:Database,scope:VectorScope,table:string,session?:string,after?:number,limit?:number,message?:string) {
  const binary=table==="message_vectors";
  const params:any[]=[scope.provider_kind,scope.provider_model,scope.dimension];
  if(session!==undefined)params.push(session);
  if(message!==undefined)params.push(message);
  if(after!==undefined)params.push(after,limit);
  // Startup uses indexed rowid batches; refresh uses the session index rather
  // than rescanning every legacy row in this model for each affected session.
  const index=session!==undefined ? `INDEXED BY ${binary ? "message_vector_session" : "legacy_vector_session"}` : after!==undefined ? "NOT INDEXED" : "";
  if(!binary) {
    // Valid binary identities are already in the matrix. Reading legacy FTS
    // text for those duplicates adds I/O to every dirty-session refresh.
    const statement=db.query(`SELECT v.rowid AS vector_rowid,v.session_id,v.message_id FROM ${table} v ${index}
      WHERE v.provider_kind=? AND COALESCE(v.provider_model,'')=? AND v.dimension=?
      ${session!==undefined ? "AND v.session_id=?" : ""} ${message!==undefined ? "AND v.message_id=?" : ""}
      ${after!==undefined ? "AND v.rowid>? ORDER BY v.rowid LIMIT ?" : ""}`);
    return after===undefined ? statement.iterate(...params) : statement.all(...params);
  }
  const statement=db.query(`SELECT v.rowid AS vector_rowid,v.session_id,v.message_id,${binary ? "v.embedding" : "NULL"} AS embedding,
    ${binary ? "v.text_hash" : "NULL"} AS text_hash,f.rowid,f.text,f.source,f.title
    FROM ${table} v ${index} JOIN message_lookup k ON k.session_id=v.session_id AND k.message_id=v.message_id
    JOIN messages_fts f ON f.rowid=k.fts_rowid AND f.session_id=v.session_id AND f.message_id=v.message_id
    WHERE v.provider_kind=? AND ${binary ? "v.provider_model" : "COALESCE(v.provider_model,'')"}=? AND v.dimension=?
    ${session!==undefined ? "AND v.session_id=?" : ""} ${message!==undefined ? "AND v.message_id=?" : ""} AND v.title IS f.title
    AND ${binary ? "(v.text_hash IS NOT NULL OR v.text=f.text)" : "v.text=f.text"}
    ${after!==undefined ? "AND v.rowid>? ORDER BY v.rowid LIMIT ?" : ""}`);
  return after===undefined ? statement.iterate(...params) : statement.all(...params);
}
function appendVectors(db:Database,cache:Cache,scope:VectorScope,table:string,rows:Iterable<any>):void {
  const binary=table==="message_vectors";
  for(let row of rows) {
      const key=identity(row.session_id,row.message_id);
      if(cache.identities.has(key))continue;
      if(!binary) {
        row=db.query(`SELECT v.embedding,f.text,f.source,f.title,f.rowid,v.session_id,v.message_id FROM message_embeddings v
          JOIN message_lookup k ON k.session_id=v.session_id AND k.message_id=v.message_id
          JOIN messages_fts f ON f.rowid=k.fts_rowid AND f.session_id=v.session_id AND f.message_id=v.message_id
          WHERE v.session_id=? AND v.message_id=? AND v.provider_kind=? AND COALESCE(v.provider_model,'')=? AND v.dimension=?
          AND v.title IS f.title AND v.text=f.text`).get(row.session_id,row.message_id,scope.provider_kind,scope.provider_model,scope.dimension);
        if(!row)continue;
      }
      if(row.text_hash && row.text_hash!==textVectorHash(row.text)) continue;
      let vector:ArrayLike<number>;
      try {
        vector=binary ? decodeVector(row.embedding,scope.dimension) : JSON.parse(row.embedding);
        if(!binary && (!Array.isArray(vector) || vector.length!==scope.dimension || !vector.every(v=>typeof v==="number" && Number.isFinite(v)))) continue;
      } catch {continue;}
      let norm=0;for(let i=0;i<scope.dimension;i++) norm+=vector[i]*vector[i];
      if(!norm) continue;
      norm=Math.sqrt(norm);
      const index=cache.free.pop() ?? cache.entries.length;
      if((index+1)*scope.dimension>cache.matrix.length) {
        const matrix=new Float32Array(cache.matrix.length+scope.dimension*1024);
        matrix.set(cache.matrix);cache.matrix=matrix;
      }
      const offset=index*scope.dimension;
      for(let i=0;i<scope.dimension;i++) cache.matrix[offset+i]=vector[i]/norm;
      cache.entries[index]={session_id:row.session_id,message_id:row.message_id,rowid:row.rowid,source:row.source,
        hash:row.text_hash ?? textVectorHash(row.text),title:row.title};
      cache.identities.set(key,index);
  }
}
function fill(db:Database,cache:Cache,scope:VectorScope,session?:string,message?:string):void {
  for(const table of ["message_vectors","message_embeddings"])
    appendVectors(db,cache,scope,table,vectorRows(db,scope,table,session,undefined,undefined,message));
}
function emptyCache(db:Database,scope:VectorScope):Cache {
  // The larger table is a cheap allocation estimate. Distinct UNION counting
  // sorts every identity; retained JSON usually duplicates binary identities.
  const params=[scope.provider_kind,scope.provider_model,scope.dimension];
  const binary=(db.query("SELECT COUNT(*) AS n FROM message_vectors WHERE provider_kind=? AND provider_model=? AND dimension=?").get(...params) as {n:number}).n;
  const legacy=(db.query("SELECT COUNT(*) AS n FROM message_embeddings WHERE provider_kind=? AND COALESCE(provider_model,'')=? AND dimension=?").get(...params) as {n:number}).n;
  const built=(builds.get(db) ?? 0)+1;builds.set(db,built);
  return {builds:built,scope:JSON.stringify(scope),revision:searchRevision(db),session_refreshes:0,message_refreshes:0,dimension:scope.dimension,...counters(db),
    matrix:new Float32Array(Math.max(1,Math.ceil(Math.max(binary,legacy)/1024))*1024*scope.dimension),entries:[],identities:new Map(),free:[]};
}
function invalidateSessions(cache:Cache,dirty:Set<string>) {
  cache.session_refreshes+=dirty.size;
  for(let i=0;i<cache.entries.length;i++) {
    const entry=cache.entries[i];
    if(entry && dirty.has(entry.session_id)) {cache.identities.delete(identity(entry.session_id,entry.message_id));cache.entries[i]=null;cache.free.push(i);}
  }
}
/** Publish one complete matrix after cooperative read/decode/normalize batches. */
export async function warmActiveVectorCache(db:Database,scope:VectorScope,opts:WarmupOptions,onProgress:(rows:number)=>void) {
  const cache=emptyCache(db,scope);
  const batch=opts.batchSize ?? 64;
  async function fillBatches(session?:string) {
    for(const table of ["message_vectors","message_embeddings"]) {
      let cursor=0;
      while(true) {
        opts.signal?.throwIfAborted();
        const rows=Array.from(vectorRows(db,scope,table,session,cursor,batch)) as any[];
        appendVectors(db,cache,scope,table,rows);onProgress(cache.identities.size);
        if(rows.length<batch)break;
        cursor=rows.at(-1).vector_rowid;
        await (opts.yield?.() ?? Bun.sleep(0));
      }
      await (opts.yield?.() ?? Bun.sleep(0));
    }
  }
  await fillBatches();
  // Catch edits made during yields before exposing a ready matrix.
  while(cache.revision!==searchRevision(db)) {
    const revision=searchRevision(db),dirty=changedSearchSessions(db,cache.revision,scope);
    invalidateSessions(cache,dirty);
    for(const session of dirty)await fillBatches(session);
    cache.revision=revision;
  }
  Object.assign(cache,counters(db));active.set(db,cache);
}

function load(db:Database,scope:VectorScope):Cache {
  const key=JSON.stringify(scope), revision=searchRevision(db), state=counters(db);
  let cache=active.get(db);
  if(!cache || cache.scope!==key || revision<cache.revision || revision===cache.revision &&
    (state.changes!==cache.changes || state.dataVersion!==cache.dataVersion)) {
    cache=emptyCache(db,scope);
    fill(db,cache,scope);active.set(db,cache);
  } else if(revision!==cache.revision) {
    const dirty=changedSearchSessions(db,cache.revision);
    const messages=changedSearchVectors(db,cache.revision,scope).filter(row=>!dirty.has(row.session_id));
    invalidateSessions(cache,dirty);
    cache.session_refreshes+=new Set(messages.map(row=>row.session_id)).size;
    cache.message_refreshes+=messages.length;
    for(const row of messages) {
      const key=identity(row.session_id,row.message_id),index=cache.identities.get(key);
      if(index!==undefined) {cache.identities.delete(key);cache.entries[index]=null;cache.free.push(index);}
    }
    for(const session of dirty)fill(db,cache,scope,session);
    for(const row of messages)fill(db,cache,scope,row.session_id,row.message_id);
  }
  Object.assign(cache,{revision,...counters(db)});
  return cache;
}

/** One lazily loaded, normalized matrix per open index, replaced on model switch.
 * Only the winning rows fetch chat text; writes refresh affected sessions. */
export function cachedSemanticCandidates(db:Database,query:number[],scope:VectorScope,source:string|undefined,limit:number) {
  ensureMessageLookup(db);
  return db.transaction(()=>candidatesSnapshot(db,query,scope,source,limit))();
}

function candidatesSnapshot(db:Database,query:number[],scope:VectorScope,source:string|undefined,limit:number) {
  const cache=load(db,scope), ranked:Array<{index:number;similarity:number}>=[];
  const q=Float64Array.from(query);let norm=0;for(const value of q) norm+=value*value;
  if(!norm)return [];
  norm=Math.sqrt(norm);for(let i=0;i<q.length;i++)q[i]/=norm;
  const matrix=cache.matrix, dimension=scope.dimension;
  for(let index=0;index<cache.entries.length;index++) {
    const entry=cache.entries[index];if(!entry || source && entry.source!==source) continue;
    let similarity=0;const offset=index*dimension;
    for(let j=0;j<dimension;j++) similarity+=q[j]*matrix[offset+j];
    if(similarity<=0 || ranked.length>=limit && similarity<=ranked[ranked.length-1].similarity) continue;
    ranked.push({index,similarity});ranked.sort((a,b)=>b.similarity-a.similarity);if(ranked.length>limit)ranked.pop();
  }
  const read=db.query("SELECT text,role,created_at,title FROM messages_fts WHERE rowid=? AND session_id=? AND message_id=?");
  return ranked.flatMap(({index,similarity})=>{
    const entry=cache.entries[index]!;
    const row=read.get(entry.rowid,entry.session_id,entry.message_id) as {text:string;role:string;created_at:string|null;title:string|null}|null;
    if(!row || row.title!==entry.title || textVectorHash(row.text)!==entry.hash)return [];
    return [{...entry,...row,similarity}];
  });
}

/** Lightweight diagnostics for refresh profiling and service health. */
export function activeVectorCacheStatus(db:Database) {
  const cache=active.get(db);
  return cache ? {builds:cache.builds,scope:JSON.parse(cache.scope) as VectorScope,rows:cache.identities.size,session_refreshes:cache.session_refreshes,message_refreshes:cache.message_refreshes} : null;
}
