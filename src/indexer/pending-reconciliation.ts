import type {Database} from 'bun:sqlite';
import {messageLookupBatch} from './message-lookup';
import {searchRevision} from './search-revision';

/** Rollback binaries still fire session revision triggers. Consume that indexed
 * feed to a fixed boundary, retaining later captures for the next invocation. */
export async function reconcilePendingChanges(db:Database,kind:string,model:string,opts:{
 signal?:AbortSignal;assertLease?:()=>void;yield?:()=>Promise<void>;
 upsert:(row:any)=>void;assets?: (session:string)=>void;
}) {
 const upper=searchRevision(db),pause=opts.yield ?? (()=>Bun.sleep(0));
 const guard=()=>{opts.signal?.throwIfAborted();opts.assertLease?.();};
 const write=<T>(run:()=>T)=>db.transaction(()=>{guard();const result=run();guard();return result;}).immediate();
 // Normal captures maintain this map directly. Only initial build and rollback
 // writes need catch-up. Bodies below always use indexed identity/FTS rowid reads.
 while(!write(()=>messageLookupBatch(db,64)))await pause();
 while(true) {
  guard();
  const state=db.query('SELECT pending_revision FROM embedding_models WHERE provider_kind=? AND provider_model=?')
   .get(kind,model) as {pending_revision:number};
  const next=db.query('SELECT MIN(revision) AS revision FROM search_changes WHERE revision>? AND revision<=?')
   .get(state.pending_revision,upper) as {revision:number|null};
  if(next.revision===null) {write(()=>db.run('UPDATE embedding_models SET pending_revision=MAX(pending_revision,?) WHERE provider_kind=? AND provider_model=?',[upper,kind,model]));return;}
  // Consume a complete equal-revision group before advancing its watermark.
  const sessions=db.query('SELECT session_id FROM search_changes WHERE revision=?').all(next.revision) as Array<{session_id:string}>;
  for(const {session_id} of sessions) {
   const unchanged=()=>!!db.query('SELECT 1 FROM search_changes WHERE session_id=? AND revision=?').get(session_id,next.revision);
   let cursor='';
   while(true) {
    const page=write(()=>{
     if(!unchanged())return null;
     const rows=db.query(`SELECT f.rowid,f.*,s.updated_at FROM message_lookup k
       JOIN messages_fts f ON f.rowid=k.fts_rowid AND f.session_id=k.session_id AND f.message_id=k.message_id
       JOIN sessions s ON s.id=k.session_id WHERE k.session_id=? AND k.message_id>? ORDER BY k.message_id LIMIT 64`)
      .all(session_id,cursor) as any[];
     for(const row of rows)opts.upsert(row);
     return rows;
    });
    if(page===null || page.length<64)break;
    cursor=page.at(-1)!.message_id;await pause();
   }
   // Prune obsolete vectors/markers in pages too. A newer session generation
   // interrupts this work and remains beyond our watermark for a later pass.
   for(const table of ['embedding_pending','message_vectors','message_vector_chunks','message_embeddings']) {
    cursor='';
    while(true) {
     const page=write(()=>{
      if(!unchanged())return null;
      const rows=db.query(`SELECT DISTINCT message_id FROM ${table} WHERE session_id=? AND provider_kind=? AND provider_model IS ? AND message_id>? ORDER BY message_id LIMIT 64`)
       .all(session_id,kind,model,cursor) as Array<{message_id:string}>;
      for(const row of rows)db.run(`DELETE FROM ${table} WHERE session_id=? AND message_id=? AND provider_kind=? AND provider_model IS ?
       AND NOT EXISTS (SELECT 1 FROM message_lookup k JOIN messages_fts f ON f.rowid=k.fts_rowid
        AND f.session_id=k.session_id AND f.message_id=k.message_id JOIN sessions s ON s.id=k.session_id WHERE k.session_id=? AND k.message_id=?)`,
       [session_id,row.message_id,kind,model,session_id,row.message_id]);
      return rows;
     });
     if(page===null || page.length<64)break;
     cursor=page.at(-1)!.message_id;await pause();
    }
   }
   if(opts.assets)write(()=>{if(unchanged())opts.assets!(session_id);});
   await pause();
  }
  write(()=>db.run('UPDATE embedding_models SET pending_revision=? WHERE provider_kind=? AND provider_model=?',[next.revision,kind,model]));
 }
}
