import type {Database} from 'bun:sqlite';
import {deferWalCheckpoints} from './background-wal-checkpoint';
import {loadavg} from 'node:os';
import {assetBlobPath} from '../store/assets';
import type {EmbeddingProvider} from './sqlite';
import {BackfillLeaseLost,type BackfillLeaseStatus} from './backfill-lock';
import {assetCoverage,embedAsset} from './asset-embeddings';
import {validateEmbedding} from './embedding-status';
import {EmbeddingGemmaProvider,type EmbeddingGemmaContext} from './embedding-providers';
import {vectorScope,textVectorHash,putTextChunks,reusableTextVector} from './vector-store';
import {documentChunks} from './document-chunks';
import {classifyEmbeddingFailure,recordFailure,type ConnectionSequence} from './embedding-failures';
import {initializePendingEmbeddings,pendingEmbeddingRows,pendingCoverage,pendingWorkEstimate,completePendingEmbedding,deferPendingEmbedding,type PendingEmbeddingRow} from './pending-embeddings';
export {textCoverage} from './text-coverage';
export interface BackfillReport {
  lease?: BackfillLeaseStatus;
  queue?: {pending:number;deferred:number;skipped:number;empty:number;reasons:Record<string,number>};
  /** Background scan progress, without an archive-wide coverage probe. */
  scan?: { cursor: number; asset_cursor: string; scanned: number; exhausted: boolean };
  event: "progress" | "load_pause" | "complete";
  embedded: number; converted: number; skipped: number; failed: number; stale: number; attempted: number;
  deferred: number; permanently_skipped: number; truncated: number; provider_outage: boolean;
  coverage_at_attempt: number | null;
  text: { total: number; embedded: number } | null; assets: { total: number; embedded: number } | null;
  requests: number; estimated_requests: number | null; remaining_requests: number | null;
  estimated_compute_chunks: number | null; remaining_compute_chunks: number | null;
  elapsed_seconds: number; mean_request_seconds: number | null;
  eta_seconds: number | null; eta_basis: "assumed_2s_per_compute_chunk" | "observed";
}

class StaleEmbeddingInput extends Error {}
export interface BackfillOptions {
 provider:EmbeddingProvider;canonicalDir?:string;limit?:number;rate?:number;loadThreshold?:number;
 signal?:AbortSignal;load?:()=>number;sleep?:(ms:number)=>Promise<void>;now?:()=>number;wallNow?:()=>number;
 progress?:(report:BackfillReport)=>void;assertLease?:()=>void;leaseStatus?:()=>BackfillLeaseStatus;
 background?:{cursor:number;assetCursor?:string;scanLimit:number};yieldToQueries?:()=>Promise<void>;
 connectionSequence?:ConnectionSequence;
}
export async function embedBackfill(db:Database,opts:BackfillOptions):Promise<BackfillReport> {
 const wal=deferWalCheckpoints(db);
 try {return await runBackfill(db,{...opts,yieldToQueries:async()=>{await (opts.yieldToQueries?.() ?? Bun.sleep(0));await wal.checkpoint();}});}
 finally {wal.restore();}
}
async function runBackfill(db:Database,opts:BackfillOptions):Promise<BackfillReport> {
 const {provider,signal}=opts,rate=opts.rate ?? 10,limit=opts.limit ?? Infinity;
 if(!Number.isFinite(rate)||rate<=0||opts.limit!==undefined && (!Number.isInteger(limit)||limit<1) ||
  opts.loadThreshold!==undefined && (!Number.isFinite(opts.loadThreshold)||opts.loadThreshold<=0))throw new Error('invalid backfill controls');
 if(!provider.kind || !provider.model)throw new Error('backfill requires an explicit provider and model');
 if(opts.background && (!Number.isSafeInteger(opts.background.scanLimit)||opts.background.scanLimit<1||!Number.isFinite(limit)))throw new Error('background backfill requires bounded limits');
 const now=opts.now ?? (()=>performance.now()),wallNow=opts.wallNow ?? Date.now,started=now();
 const pause=opts.yieldToQueries ?? (()=>Bun.sleep(0));
 const sleep=opts.sleep ?? (async(ms:number)=>{await new Promise<void>((resolve,reject)=>{
  signal?.throwIfAborted();const abort=()=>{clearTimeout(timer);reject(signal?.reason);};
  const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);
  signal?.addEventListener('abort',abort,{once:true});
 });});
 let embedded=0,skipped=0,failed=0,stale=0,attempted=0,deferred=0,permanently_skipped=0,truncated=0,requests=0;
 let requestMs=0,measured=0,needsPacing=false,provider_outage=false,prepared=false;
 let estimated:number|null=null;
 const sequence=opts.connectionSequence ?? {count:0,lastItem:null};
 const guard=()=>{signal?.throwIfAborted();opts.assertLease?.();};
 const report=(event:BackfillReport['event']):BackfillReport=> {
  const coverage=prepared ? pendingCoverage(db,provider) : null;
  const remaining=estimated===null ? null : pendingWorkEstimate(db,provider),mean=measured ? requestMs/measured/1000 : null;
  return {event,embedded,converted:0,skipped,failed,stale,attempted,deferred,permanently_skipped,truncated,provider_outage,
   ...(coverage ? {queue:{pending:coverage.pending,deferred:coverage.deferred,skipped:coverage.skipped,empty:coverage.empty,reasons:coverage.reasons}} : {}),
   coverage_at_attempt:coverage ? attempted : null,text:coverage ? {total:coverage.total,embedded:coverage.embedded} : null,
   assets:prepared && provider.embedAsset ? assetCoverage(db,provider) : null,
   ...(opts.leaseStatus ? {lease:opts.leaseStatus()} : {}),
   ...(opts.background ? {scan:{cursor:0,asset_cursor:'',scanned:attempted,exhausted:pendingEmbeddingRows(db,provider,1,wallNow()).length===0}} : {}),
   requests,estimated_requests:estimated,remaining_requests:remaining,estimated_compute_chunks:estimated,remaining_compute_chunks:remaining,
   elapsed_seconds:Math.max(0,now()-started)/1000,mean_request_seconds:mean,
   eta_seconds:remaining===null ? null : remaining*((mean ?? 2)+1/rate),eta_basis:mean===null ? 'assumed_2s_per_compute_chunk' : 'observed'};
 };
 const wait=async()=> {
  guard();while(opts.loadThreshold!==undefined && (opts.load ?? (()=>loadavg()[0]))()>opts.loadThreshold) {
   opts.progress?.(report('load_pause'));await sleep(5000);guard();
  }
 };
 await wait();
 await initializePendingEmbeddings(db,provider,{signal,yield:pause,assertLease:opts.assertLease});prepared=true;
 const coverage=pendingCoverage(db,provider);
 if(!opts.background) {
  skipped=coverage.embedded+coverage.empty;
 }
 estimated=pendingWorkEstimate(db,provider);
 opts.progress?.(report('progress'));
 const infer=async(call:(context:EmbeddingGemmaContext)=>number[]|Promise<number[]>,check:()=>void,title?:string|null)=> {
  const hooks=provider instanceof EmbeddingGemmaProvider;let startedAt:number|null=null;
  const before=async()=> {await pause();if(needsPacing){await sleep(1000/rate);needsPacing=false;}await wait();guard();check();};
  const start=()=>{requests++;needsPacing=true;startedAt=now();};
  const success=()=> {if(startedAt!==null){requestMs+=Math.max(0,now()-startedAt);measured++;startedAt=null;}};
  const context:EmbeddingGemmaContext={kind:'document',title,signal,beforeRequest:before,onRequest:hooks ? start : undefined,onRequestSuccess:hooks ? success : undefined};
  if(!hooks){await before();start();context.beforeRequest=async()=>{guard();check();};}
  const vector=validateEmbedding(await call(context));guard();vectorScope(provider,vector.length);if(!hooks)success();return vector;
 };
 const current=(row:PendingEmbeddingRow)=>db.query('SELECT text,title FROM messages_fts WHERE rowid=? AND session_id=? AND message_id=?')
  .get(row.fts_rowid,row.session_id,row.message_id) as {text:string;title:string|null}|null;
 const discard=(row:PendingEmbeddingRow)=>db.run(`DELETE FROM embedding_pending WHERE session_id=? AND message_id=? AND provider_kind=? AND provider_model=? AND input_hash=? AND title IS ? AND fts_rowid=?`,
  [row.session_id,row.message_id,row.provider_kind,row.provider_model,row.input_hash,row.title,row.fts_rowid]);
 while(attempted<limit && !provider_outage) {
  guard();const rows=pendingEmbeddingRows(db,provider,Math.min(25,limit-attempted),wallNow());if(!rows.length)break;
  for(const row of rows) {
   guard();if(attempted>=limit || provider_outage)break;
   const check=()=> {
    if(row.type!=='text') {if(!db.query('SELECT 1 FROM asset_embedding_links WHERE sha256=?').get(row.message_id))throw new StaleEmbeddingInput();return;}
    const live=current(row);if(!live || textVectorHash(live.text)!==row.input_hash || live.title!==row.title)throw new StaleEmbeddingInput();
   };
   if(row.type!=='text' && (!provider.embedAsset || !opts.canonicalDir)){skipped++;discard(row);continue;}
   try {
    check();
    if(row.type==='text' && row.reason!=='chunk_set_rebuild' && reusableTextVector(db,row.session_id,row.message_id,row.text,row.title,provider)) {
     db.transaction(()=>{guard();check();completePendingEmbedding(db,row);guard();}).immediate();skipped++;continue;
    }
    attempted++;
    if(row.type==='text') {
     const chunks=documentChunks(row.text,provider),vectors:number[][]=[];
     for(const chunk of chunks.chunks)vectors.push(await infer(context=>provider.embed(chunk,context),check,row.title));
     db.transaction(()=>{guard();check();putTextChunks(db,{...row,...vectorScope(provider,vectors[0].length),embedding:vectors[0]},vectors);
      completePendingEmbedding(db,row,chunks.truncated);guard();}).immediate();
     if(chunks.truncated)truncated++;
    } else {
     const requestProvider:EmbeddingProvider={...provider,kind:provider.kind,model:provider.model,dimensions:provider.dimensions,
      embed:provider.embed.bind(provider),embedAsset:input=>infer(context=>provider.embedAsset!(input,context),check)};
     await embedAsset(db,row.message_id,assetBlobPath(opts.canonicalDir!,row.message_id),requestProvider,signal,opts.assertLease);
     db.transaction(()=>{guard();completePendingEmbedding(db,row);guard();}).immediate();
    }
    embedded++;sequence.count=0;sequence.lastItem=null;
   } catch(error) {
    guard();if(error instanceof BackfillLeaseLost)throw error;
    if(error instanceof StaleEmbeddingInput){stale++;discard(row);continue;}
    const failure=classifyEmbeddingFailure(error);
    const result=db.transaction(()=>{guard();const result=deferPendingEmbedding(db,row,failure,wallNow());guard();return result;}).immediate();
    if(!result){stale++;continue;}
    if(result.state==='skipped'){skipped++;permanently_skipped++;}else deferred++;
    provider_outage=recordFailure(sequence,`${row.session_id}\0${row.message_id}`,failure);
   }
   opts.progress?.(report('progress'));await pause();
  }
 }
 const complete=report('complete');opts.progress?.(complete);return complete;
}
