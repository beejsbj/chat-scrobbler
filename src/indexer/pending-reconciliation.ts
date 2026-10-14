import type {Database} from 'bun:sqlite';

/** Rollback binaries still fire session revision triggers. Consume their durable
 * feed without sharing the lookup's disposable dirty markers or scanning the archive. */
export async function reconcilePendingChanges(db:Database,kind:string,model:string,opts:{
 signal?:AbortSignal;assertLease?:()=>void;yield?:()=>Promise<void>;
 upsert:(row:any)=>void;assets?: (session:string)=>void;
}) {
 while(true) {
  opts.signal?.throwIfAborted();
  const changed=db.transaction(()=>{
   opts.assertLease?.();
   const state=db.query('SELECT pending_revision FROM embedding_models WHERE provider_kind=? AND provider_model=?')
    .get(kind,model) as {pending_revision:number};
   // One revision group per bounded maintenance step; duplicate revision values
   // must be consumed together before the watermark can advance.
   const next=db.query('SELECT MIN(revision) AS revision FROM search_changes WHERE revision>?').get(state.pending_revision) as {revision:number|null};
   if(next.revision===null)return false;
   const sessions=db.query('SELECT session_id FROM search_changes WHERE revision=?').all(next.revision) as Array<{session_id:string}>;
   for(const {session_id} of sessions) {
    const rows=db.query(`SELECT f.rowid,f.*,s.updated_at FROM messages_fts f JOIN sessions s ON s.id=f.session_id WHERE f.session_id=?`)
     .all(session_id) as any[];
    const ids=new Set(rows.map(row=>row.message_id));
    for(const table of ['embedding_pending','message_vectors','message_vector_chunks','message_embeddings']) {
     const existing=db.query(`SELECT message_id FROM ${table} WHERE session_id=? AND provider_kind=? AND provider_model IS ?`)
      .all(session_id,kind,model) as Array<{message_id:string}>;
     for(const row of existing)if(!ids.has(row.message_id))db.run(`DELETE FROM ${table} WHERE session_id=? AND message_id=? AND provider_kind=? AND provider_model IS ?`,
      [session_id,row.message_id,kind,model]);
    }
    for(const row of rows)opts.upsert(row);
    opts.assets?.(session_id);
   }
   db.run('UPDATE embedding_models SET pending_revision=? WHERE provider_kind=? AND provider_model=?',[next.revision,kind,model]);
   opts.assertLease?.();return true;
  }).immediate();
  if(!changed)return;
  await (opts.yield?.() ?? Bun.sleep(0));
 }
}
