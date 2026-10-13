import type { Database } from "bun:sqlite";
import { ensureMessageLookup } from "./message-lookup";
import { searchRevision } from "./search-revision";
import { decodeVector, textVectorHash, type VectorScope } from "./vector-store";

interface Entry { session_id:string; message_id:string; rowid:number; source:string; }
interface Cache {
  scope:string; revision:number; changes:number; dataVersion:number; dimension:number;
  matrix:Float32Array; entries:Array<Entry|null>; identities:Map<string,number>; free:number[];
}
const active=new WeakMap<Database,Cache>();
const identity=(s:string,m:string)=>`${s}\0${m}`;
const counters=(db:Database)=>({changes:(db.query("SELECT total_changes() AS n").get() as {n:number}).n,
  dataVersion:(db.query("PRAGMA data_version").get() as {data_version:number}).data_version});

function fill(db:Database,cache:Cache,scope:VectorScope,session?:string):void {
  const params=[scope.provider_kind,scope.provider_model,scope.dimension,...(session ? [session] : [])];
  for(const table of ["message_vectors","message_embeddings"]) {
    const binary=table==="message_vectors";
    const rows=db.query(`SELECT v.session_id,v.message_id,${binary ? "v.embedding" : "NULL"} AS embedding,
      ${binary ? "v.text_hash" : "NULL"} AS text_hash,f.rowid,f.text,f.source
      FROM ${table} v JOIN message_lookup k ON k.session_id=v.session_id AND k.message_id=v.message_id
      JOIN messages_fts f ON f.rowid=k.fts_rowid
      WHERE v.provider_kind=? AND ${binary ? "v.provider_model" : "COALESCE(v.provider_model,'')"}=? AND v.dimension=?
      ${session ? "AND v.session_id=?" : ""} AND v.title IS f.title
      AND ${binary ? "(v.text_hash IS NOT NULL OR v.text=f.text)" : "v.text=f.text"}`);
    for(const row of rows.iterate(...params) as Iterable<any>) {
      const key=identity(row.session_id,row.message_id);
      if(cache.identities.has(key) || row.text_hash && row.text_hash!==textVectorHash(row.text)) continue;
      let vector:ArrayLike<number>;
      try {
        vector=binary ? decodeVector(row.embedding,scope.dimension) : JSON.parse((db.query(`SELECT embedding FROM message_embeddings
          WHERE session_id=? AND message_id=?`).get(row.session_id,row.message_id) as {embedding:string}).embedding);
        if(!binary && (!Array.isArray(vector) || vector.length!==scope.dimension || !vector.every(v=>typeof v==="number" && Number.isFinite(v)))) continue;
      } catch {continue;}
      let norm=0;for(let i=0;i<scope.dimension;i++) norm+=vector[i]*vector[i];
      if(!norm) continue;
      norm=Math.sqrt(norm);
      const index=cache.free.pop() ?? cache.entries.length;
      if((index+1)*scope.dimension>cache.matrix.length) {
        const matrix=new Float32Array(Math.max(scope.dimension*1024,cache.matrix.length*2));
        matrix.set(cache.matrix);cache.matrix=matrix;
      }
      const offset=index*scope.dimension;
      for(let i=0;i<scope.dimension;i++) cache.matrix[offset+i]=vector[i]/norm;
      cache.entries[index]={session_id:row.session_id,message_id:row.message_id,rowid:row.rowid,source:row.source};
      cache.identities.set(key,index);
    }
  }
}

function load(db:Database,scope:VectorScope):Cache {
  ensureMessageLookup(db);
  const key=JSON.stringify(scope), revision=searchRevision(db), state=counters(db);
  let cache=active.get(db);
  if(!cache || cache.scope!==key || revision===cache.revision &&
    (state.changes!==cache.changes || state.dataVersion!==cache.dataVersion)) {
    // Count distinct identities to avoid allocating twice for retained JSON.
    const count=(db.query(`SELECT COUNT(*) AS n FROM (
      SELECT session_id,message_id FROM message_vectors WHERE provider_kind=? AND provider_model=? AND dimension=?
      UNION SELECT session_id,message_id FROM message_embeddings WHERE provider_kind=? AND COALESCE(provider_model,'')=? AND dimension=?)`)
      .get(scope.provider_kind,scope.provider_model,scope.dimension,scope.provider_kind,scope.provider_model,scope.dimension) as {n:number}).n;
    cache={scope:key,revision,dimension:scope.dimension,...state,matrix:new Float32Array(Math.max(count,1024)*scope.dimension),entries:[],identities:new Map(),free:[]};
    fill(db,cache,scope);active.set(db,cache);
  } else if(revision!==cache.revision) {
    const dirty=new Set((db.query("SELECT session_id FROM search_changes WHERE revision>?").all(cache.revision) as Array<{session_id:string}>).map(r=>r.session_id));
    for(let i=0;i<cache.entries.length;i++) {
      const entry=cache.entries[i];
      if(entry && dirty.has(entry.session_id)) {cache.identities.delete(identity(entry.session_id,entry.message_id));cache.entries[i]=null;cache.free.push(i);}
    }
    for(const session of dirty) fill(db,cache,scope,session);
  }
  Object.assign(cache,{revision,...counters(db)});
  return cache;
}

/** One lazily loaded, normalized matrix per open index, replaced on model switch.
 * Only the winning rows fetch chat text; writes refresh affected sessions. */
export function cachedSemanticCandidates(db:Database,query:number[],scope:VectorScope,source:string|undefined,limit:number) {
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
  const read=db.query("SELECT text,role,created_at,title FROM messages_fts WHERE rowid=?");
  return ranked.map(({index,similarity})=>{
    const entry=cache.entries[index]!;
    const row=read.get(entry.rowid) as {text:string;role:string;created_at:string|null;title:string|null};
    return {...entry,...row,similarity};
  });
}
