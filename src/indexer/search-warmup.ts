import {cooperativeWrite} from './cooperative-write';
import type {Database} from 'bun:sqlite';
import type {EmbeddingProvider} from './sqlite';
import {messageLookupBatch} from './message-lookup';
import {warmActiveVectorCache} from './active-vector-cache';
import {warmLiteralCache} from './literal-cache';
import {vectorScope} from './vector-store';
import {deferWalCheckpoints} from './background-wal-checkpoint';

export interface WarmupOptions {batchSize?:number;yield?:()=>Promise<void>;signal?:AbortSignal;}
interface WarmupState {
  state:'warming'|'ready'|'failed';stage:'lookup'|'vectors'|'literal'|'complete';rows:number;
  failure?:{name:string;code?:string|number;stage:WarmupState['stage'];operation:string};
}
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
  let operation='lookup';
  const job=(async()=> {
    try {
      const wal=deferWalCheckpoints(db);
      const pause=async()=> {
        opts.signal?.throwIfAborted();
        operation='yield';
        await yieldWarmup(opts);
        opts.signal?.throwIfAborted();
        operation='checkpoint';
        await wal.checkpoint();
        opts.signal?.throwIfAborted();
        operation=state.stage;
      };
      try {
        // Yield immediately, allowing a request arriving with startup to get FTS recall.
        await pause();
        while(!await cooperativeWrite(db,()=>messageLookupBatch(db,batchSize),opts.signal))await pause();
        state.stage='vectors';operation='vectors';
        if(provider) {
          const kind=provider.kind?.trim() || 'unknown',model=provider.model?.trim() || '';
          const binary=db.query('SELECT dimension FROM message_vectors WHERE provider_kind=? AND provider_model=? ORDER BY dimension DESC LIMIT 1').get(kind,model) as {dimension:number}|null;
          const legacy=binary ? null : db.query("SELECT dimension FROM message_embeddings WHERE provider_kind=? AND COALESCE(provider_model,'')=? ORDER BY dimension DESC LIMIT 1").get(kind,model) as {dimension:number}|null;
          const dimension=provider.dimensions ?? binary?.dimension ?? legacy?.dimension;
          if(dimension)await warmActiveVectorCache(db,vectorScope(provider,dimension),{batchSize,yield:pause},n=>state.rows=n);
        }
        state.stage='literal';operation='literal';state.rows=0;
        await warmLiteralCache(db,{batchSize,yield:pause},n=>state.rows=n);
      } finally {wal.restore();}
      state.stage='complete';state.state='ready';
    }catch(error) {
      const details=error instanceof Error ? error as Error & {code?:unknown;errno?:unknown} : null;
      const name=details && ['Error','TypeError','RangeError','AbortError','SQLiteError'].includes(details.name) ? details.name : 'Error';
      const rawCode=details?.code ?? details?.errno;
      const code=typeof rawCode==='string' && (/^SQLITE_[A-Z_]{1,48}$/.test(rawCode) || ['ENOENT','EACCES','EMFILE','ENFILE','EPERM','EIO'].includes(rawCode)) ? rawCode
        : typeof rawCode==='number' && Number.isInteger(rawCode) && rawCode>=0 && rawCode<=0xffffff ? rawCode : undefined;
      state.state='failed';state.failure={name,code,stage:state.stage,operation};
      // Names/codes only: SQL errors can contain paths, IDs or transcript text.
      if(!opts.signal?.aborted)console.error(JSON.stringify({event:'search_warmup_diagnostic',...state.failure}));
      throw error;
    }
  })();
  running.set(db,job);
  void job.finally(()=>running.delete(db)).catch(()=>undefined);
  return job;
}
