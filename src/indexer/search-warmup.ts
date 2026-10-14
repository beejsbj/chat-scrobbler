import type {Database} from 'bun:sqlite';
import type {EmbeddingProvider} from './sqlite';
import {messageLookupBatch} from './message-lookup';
import {warmActiveVectorCache} from './active-vector-cache';
import {warmLiteralCache} from './literal-cache';
import {vectorScope} from './vector-store';
import {deferWalCheckpoints} from './background-wal-checkpoint';

export interface WarmupOptions {batchSize?:number;yield?:()=>Promise<void>;signal?:AbortSignal;}
interface WarmupState {state:'warming'|'ready'|'failed';stage:'lookup'|'vectors'|'literal'|'complete';rows:number;}
const states=new WeakMap<Database,WarmupState>();
const running=new WeakMap<Database,Promise<void>>();
export const searchWarmupStatus=(db:Database)=>({...states.get(db) ?? {state:'ready' as const,stage:'complete' as const,rows:0}});
export const isSearchWarming=(db:Database)=>states.get(db)?.state==='warming';
export const searchWarmupFailed=(db:Database)=>states.get(db)?.state==='failed';

async function yieldWarmup(opts:WarmupOptions):Promise<void> {
  const signal=opts.signal;
  signal?.throwIfAborted();
  const run=()=>opts.yield?.() ?? Bun.sleep(0);
  if(!signal) {await run();return;}
  await new Promise<void>((resolve,reject)=> {
    const finish=(done:()=>void)=>{signal.removeEventListener('abort',abort);done();};
    const abort=()=>finish(()=>reject(signal.reason));
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve().then(()=>{signal.throwIfAborted();return run();}).then(
      ()=>finish(resolve),error=>finish(()=>reject(error)));
  });
  signal.throwIfAborted();
}

/** Start only after listening. No inference is needed to prepare persisted vectors. */
export function warmSearchCaches(db:Database,provider:EmbeddingProvider|null,opts:WarmupOptions={}):Promise<void> {
  const existing=running.get(db);if(existing)return existing;
  const requestedBatchSize=opts.batchSize ?? 64;
  if(!Number.isInteger(requestedBatchSize) || requestedBatchSize<1)throw new Error('invalid warmup batch size');
  const batchSize=Math.min(requestedBatchSize,64);
  const state:WarmupState={state:'warming',stage:'lookup',rows:0};states.set(db,state);
  const job=(async()=> {
    try {
      const wal=deferWalCheckpoints(db);
      const pause=async()=> {
        opts.signal?.throwIfAborted();
        await yieldWarmup(opts);
        opts.signal?.throwIfAborted();
        await wal.checkpoint();
        opts.signal?.throwIfAborted();
      };
      try {
        // Yield immediately, allowing a request arriving with startup to get FTS recall.
        await pause();
        while(!messageLookupBatch(db,batchSize))await pause();
        state.stage='vectors';
        if(provider) {
          const kind=provider.kind?.trim() || 'unknown',model=provider.model?.trim() || '';
          const binary=db.query('SELECT dimension FROM message_vectors WHERE provider_kind=? AND provider_model=? ORDER BY dimension DESC LIMIT 1').get(kind,model) as {dimension:number}|null;
          const legacy=binary ? null : db.query("SELECT dimension FROM message_embeddings WHERE provider_kind=? AND COALESCE(provider_model,'')=? ORDER BY dimension DESC LIMIT 1").get(kind,model) as {dimension:number}|null;
          const dimension=provider.dimensions ?? binary?.dimension ?? legacy?.dimension;
          if(dimension)await warmActiveVectorCache(db,vectorScope(provider,dimension),{batchSize,yield:pause},n=>state.rows=n);
        }
        state.stage='literal';state.rows=0;
        await warmLiteralCache(db,{batchSize,yield:pause},n=>state.rows=n);
      } finally {wal.restore();}
      state.stage='complete';state.state='ready';
    }catch(error) {state.state='failed';throw error;}
  })();
  running.set(db,job);
  void job.finally(()=>running.delete(db)).catch(()=>undefined);
  return job;
}
