/** Bounded host-only measurement. Never upload its temporary real-index copy. */
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {parseArgs} from 'node:util';
import {Database} from 'bun:sqlite';
import {startServe} from '../src/cli/commands';
import {DEFAULT_CONFIG} from '../src/config';

const {values}=parseArgs({options:{source:{type:'string'},ollama:{type:'string'},out:{type:'string'},seconds:{type:'string',default:'90'}}});
if(!values.source || !values.ollama || !values.out)throw new Error('source, ollama and out are required');
const seconds=Number(values.seconds);if(!Number.isFinite(seconds)||seconds<10||seconds>120)throw new Error('measurement must be 10..120 seconds');
const load=await new Response(Bun.spawn(['uptime'],{stdout:'pipe',stderr:'pipe'}).stdout).text();
const one=Number(load.match(/load average:\s*([\d.]+)/)?.[1]);
if(!Number.isFinite(one)||one>8)throw new Error('host load exceeds measurement limit');
const root=mkdtempSync('/tmp/bjs548-round4-'),path=join(root,'index.db');
let handles:Awaited<ReturnType<typeof startServe>>|undefined,timer:ReturnType<typeof setInterval>|undefined;
const originalFetch=globalThis.fetch;
const queryTexts=['embedding model','backup rollback','Claude settings'];
const requests:Array<{kind:string;chars:number;ms:number;status:number}>=[];
const sourceCommit=(await new Response(Bun.spawn(['git','rev-parse','HEAD'],{stdout:'pipe'}).stdout).text()).trim();
const result:any={source_commit:sourceCommit,date:new Date().toISOString(),source_kind:'online read-only SQLite backup of live index',loadavg_before:one,
 resource_caps:{cpu_percent:200,memory_bytes:2*1024**3,swap_bytes:0,nice:19},
 ollama_caps:{cpus:1,memory_bytes:1258291200,swap_bytes:0},chunk_chars:1500,max_chunks:16};
try {
 const copy=Bun.spawn(['python3','-c',`import sqlite3,sys,pathlib
src=sqlite3.connect(pathlib.Path(sys.argv[1]).resolve().as_uri()+'?mode=ro',uri=True)
dst=sqlite3.connect(sys.argv[2]);src.backup(dst,pages=256,sleep=0.01);dst.close();src.close()
`,values.source,path],{stdout:'ignore',stderr:'ignore'});
 if(await copy.exited!==0)throw new Error('online backup failed');
 const raw=new Database(path);
 result.messages=(raw.query('SELECT COUNT(*) AS n FROM messages_fts').get() as any).n;
 result.legacy_vectors=(raw.query('SELECT COUNT(*) AS n FROM message_embeddings').get() as any).n;
 // A copied lease coordinates the original inode only; no owner can renew it in
 // this scratch database. Reset only scratch coordination, never the source.
 for(const table of ['locks','embedding_pending','embedding_models'])if(raw.query('SELECT 1 FROM sqlite_master WHERE name=?').get(table))raw.run(`DELETE FROM ${table}`);
 if(raw.query("SELECT 1 FROM sqlite_master WHERE name='message_lookup_state'").get())raw.run("UPDATE message_lookup_state SET cursor=0,ready=0 WHERE id=1");
 raw.close();
 globalThis.fetch=(async(input:string|URL|Request,init?:RequestInit)=>{
  if(String(input).startsWith(values.ollama!) && String(input).endsWith('/api/embed')) {
   const body=JSON.parse(String(init?.body)),text=String(body.input),started=performance.now();
   let status=0;
   try {const response=await originalFetch(input,init);status=response.status;return response;}
   finally {requests.push({kind:queryTexts.includes(text) ? 'query':'document',chars:text.length,ms:performance.now()-started,status});}
  }
  return originalFetch(input,init);
 }) as typeof fetch;
 const cfg={...DEFAULT_CONFIG,indexPath:path,canonicalDir:join(root,'canonical','sessions'),ingestPort:0,mcpHttpPort:0,
  embeddingProvider:'ollama' as const,embeddingModel:'nomic-embed-text',ollamaBaseUrl:values.ollama,
  embeddingChunkChars:1500,embeddingMaxChunks:16,embeddingBackfillIntervalMs:1000,embeddingBackfillBatchSize:25};
 let last=performance.now(),gap=0,startupGap=0,id=0;
 timer=setInterval(()=>{const at=performance.now();gap=Math.max(gap,at-last-10);last=at;},10);
 const startup=performance.now();handles=await startServe(cfg);
 const endpoint=`http://127.0.0.1:${handles.mcpServer.port}/mcp`;
 const search=async(query:string)=> {
  const start=performance.now();
  const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},
   body:JSON.stringify({jsonrpc:'2.0',id:++id,method:'tools/call',params:{name:'search',arguments:{query,limit:10}}})});
  if(!response.ok)throw new Error('MCP measurement request failed');
  const payload=await response.json() as any;
  if(payload.error || payload.result?.isError)throw new Error('MCP tool measurement failed');
  return {ms:performance.now()-start,semantic:payload.result?.structuredContent?.semantic};
 };
 const first=await search(queryTexts[0]);result.first_query=first;
 // Separate first-open schema work from the remaining cooperative warmup.
 await Bun.sleep(20);result.first_open_and_initial_query_max_event_loop_delay_ms=gap;gap=0;
 while(handles.backfillScheduler!.status().maintenance.state!=='complete') {
  if(performance.now()-startup>60_000)throw new Error('startup exceeded measurement bound');await Bun.sleep(50);
 }
 let warm=await search(queryTexts[0]);
 while(warm.semantic==='warming') {
  if(performance.now()-startup>90_000)throw new Error('warmup exceeded measurement bound');
  await Bun.sleep(100);warm=await search(queryTexts[0]);
 }
 if(warm.semantic!=='available')throw new Error('semantic warmup failed; measurement is invalid');
 result.startup_ms=performance.now()-startup;startupGap=gap;gap=0;
 result.startup_max_event_loop_delay_ms=startupGap;
 const inspect=new Database(path,{readonly:true});
 const complete=()=> (inspect.query("SELECT COUNT(*) AS n FROM embedding_pending WHERE provider_kind='ollama' AND provider_model='nomic-embed-text' AND state='complete' AND type='text'").get() as any).n;
 const completedBefore=complete(),started=performance.now(),latencies:number[]=[],semantics:Record<string,number>={};
 let i=0;
 while(performance.now()-started<seconds*1000) {
  const hit=await search(queryTexts[i++%queryTexts.length]);if(hit.semantic!=='available')throw new Error('semantic search became unavailable; measurement is invalid');
  latencies.push(hit.ms);semantics[String(hit.semantic)]=(semantics[String(hit.semantic)] ?? 0)+1;
  await Bun.sleep(500);
 }
 const elapsed=(performance.now()-started)/1000,completed=complete()-completedBefore;
 const states=inspect.query("SELECT state,COUNT(*) AS n FROM embedding_pending WHERE provider_kind='ollama' AND provider_model='nomic-embed-text' GROUP BY state").all();
 const chunks=(inspect.query('SELECT COUNT(*) AS n FROM message_vector_chunks').get() as any).n;
 inspect.close();
 latencies.sort((a,b)=>a-b);const percentile=(p:number)=>latencies[Math.min(latencies.length-1,Math.ceil(latencies.length*p)-1)];
 Object.assign(result,{measurement_seconds:elapsed,completed_messages:completed,messages_per_hour:completed/elapsed*3600,
  search:{count:latencies.length,median_ms:percentile(.5),p95_ms:percentile(.95),max_ms:latencies.at(-1),semantic_counts:semantics},
  running_max_event_loop_delay_ms:gap,requests:{total:requests.length,documents:requests.filter(r=>r.kind==='document').length,
   max_document_chars:Math.max(0,...requests.filter(r=>r.kind==='document').map(r=>r.chars)),failed:requests.filter(r=>r.status!==200).length},
  extra_chunk_vectors:chunks,queue_states:states,rss_mib:process.memoryUsage().rss/1024**2,maintenance:handles.backfillScheduler!.status().maintenance});
} finally {
 clearInterval(timer);await handles?.stop?.();globalThis.fetch=originalFetch;
 rmSync(root,{recursive:true,force:true});result.temporary_copy_deleted=true;
}
writeFileSync(values.out,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({completed_messages:result.completed_messages,messages_per_hour:result.messages_per_hour,search:result.search,
 startup_max_event_loop_delay_ms:result.startup_max_event_loop_delay_ms,running_max_event_loop_delay_ms:result.running_max_event_loop_delay_ms,temporary_copy_deleted:true}));
