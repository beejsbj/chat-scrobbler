import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { indexSession, openIndex } from "../src/indexer/sqlite";
import { fixture } from "./support/embedding-fixture";
import { startEmbeddingBackfillScheduler } from "../src/indexer/backfill-scheduler";

function setup() {
  const root=mkdtempSync(join(tmpdir(),"backfill-scheduler-"));
  const cfg={...DEFAULT_CONFIG,indexPath:join(root,"index.db"),canonicalDir:join(root,"canonical","sessions")};
  const db=openIndex(cfg.indexPath), session=fixture();
  session.messages=Array.from({length:4},(_,i)=>({...session.messages[0],id:`m${i}`,text:`words ${i}`}));
  indexSession(db,session); db.close();
  return {root,cfg};
}
const p={kind:"test",model:"m",dimensions:2,embed:async()=>[1,0]};

test("scheduler delays startup, processes small pending batches, exposes progress, and stops", async () => {
  const {root,cfg}=setup();
  let calls=0;
  const scheduler=startEmbeddingBackfillScheduler({cfg:{...cfg,embeddingBackfillBatchSize:2},provider:{...p,embed:async()=>{calls++;return [1,0];}}});
  try {
    expect(scheduler.status()).toMatchObject({enabled:true,running:false,state:"scheduled",last_run:null,progress:null});
    expect(Date.parse(scheduler.status().next_run_at!)-Date.now()).toBeGreaterThan(599_000);
    expect(calls).toBe(0);
    expect(await scheduler.runNow()).toMatchObject({embedded:2,attempted:2,text:{total:4,embedded:2}});
    expect(scheduler.status()).toMatchObject({running:false,state:"scheduled",last_run:{outcome:"complete",report:{embedded:2}},progress:{event:"complete"}});
    await scheduler.runNow(); expect(calls).toBe(4);
    await scheduler.runNow(); expect(calls).toBe(4);
    await scheduler.stop();
    expect(scheduler.status()).toMatchObject({state:"stopped",running:false,next_run_at:null});
    expect(await scheduler.runNow()).toBeNull();
  } finally {await scheduler.stop();rmSync(root,{recursive:true,force:true});}
});

test("disabled scheduler is lazy and does not create an index", async () => {
  const root=mkdtempSync(join(tmpdir(),"backfill-disabled-"));
  try {
    for (const provider of [null,p]) {
      const cfg={...DEFAULT_CONFIG,indexPath:join(root,"missing.db"),embeddingBackfillEnabled:provider===null};
      const scheduler=startEmbeddingBackfillScheduler({cfg,provider});
      expect(scheduler.status()).toMatchObject({enabled:false,state:"disabled",next_run_at:null});
      expect(await scheduler.runNow()).toBeNull(); await scheduler.stop();
    }
    expect(existsSync(join(root,"missing.db"))).toBe(false);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("connection failures across different items trigger jittered backoff while item failures do not",async()=> {
 const {root,cfg}=setup();let calls=0;
 const scheduler=startEmbeddingBackfillScheduler({cfg,random:()=>0,now:()=>1_000_000,
  provider:{...p,embed:async()=>{calls++;throw Object.assign(new Error("private request body"),{code:"ECONNREFUSED"});}}});
 try {
  expect(await scheduler.runNow()).toMatchObject({deferred:2,provider_outage:true,attempted:2});expect(calls).toBe(2);
  expect(scheduler.status()).toMatchObject({state:"backoff",consecutive_failures:1,last_run:{outcome:"provider_unavailable"},next_run_at:new Date(1_450_000).toISOString()});
  expect(await scheduler.runNow()).toMatchObject({deferred:1,provider_outage:true});expect(calls).toBe(3);
  expect(scheduler.status().next_run_at).toBe(new Date(1_900_000).toISOString());
  expect(JSON.stringify(scheduler.status())).not.toContain("private");
 }finally{await scheduler.stop();rmSync(root,{recursive:true,force:true});}
});

test("coalesced ticks and manual migration cannot overlap an active batch; stop aborts it", async () => {
  const {acquireBackfillLock}=await import("../src/indexer/backfill-lock");
  const {runEmbedBackfill}=await import("../src/cli/embed-backfill");
  const {root,cfg}=setup(); let enter!:()=>void;
  const entered=new Promise<void>(resolve=>{enter=resolve;});
  const scheduler=startEmbeddingBackfillScheduler({cfg,provider:{...p,embed:async(_text,context)=>{
    enter(); return new Promise<number[]>((_,reject)=>context!.signal!.addEventListener("abort",()=>reject(context!.signal!.reason),{once:true}));
  }}});
  try {
    const first=scheduler.runNow();expect(scheduler.runNow()).toBe(first);
    await entered;
    expect(scheduler.status()).toMatchObject({running:true,state:"running"});
    await expect(runEmbedBackfill(["--migrate-only"],cfg,()=>{})).rejects.toThrow("backfill already running");
    await scheduler.stop(); await first;
    expect(scheduler.status()).toMatchObject({running:false,state:"stopped",last_run:{outcome:"interrupted"}});
    const lock=acquireBackfillLock(cfg.indexPath)!; expect(lock).toBeTruthy(); lock.release();
  } finally {await scheduler.stop();rmSync(root,{recursive:true,force:true});}
});

test("a stop before the queued batch starts prevents inference", async () => {
  const {root,cfg}=setup();let calls=0;
  const scheduler=startEmbeddingBackfillScheduler({cfg,provider:{...p,embed:async()=>{calls++;return [1,0];}}});
  try {void scheduler.runNow();await scheduler.stop();expect(calls).toBe(0);}
  finally {rmSync(root,{recursive:true,force:true});}
});

test("a busy lock records a skipped run without provider failure", async () => {
  const {acquireBackfillLock}=await import("../src/indexer/backfill-lock");
  const {root,cfg}=setup(), lock=acquireBackfillLock(cfg.indexPath)!;
  const scheduler=startEmbeddingBackfillScheduler({cfg,provider:p});
  try {
    expect(await scheduler.runNow()).toBeNull();
    expect(scheduler.status()).toMatchObject({state:"locked",consecutive_failures:0,last_run:{outcome:"locked",report:null}});
    lock.release();
    expect(await scheduler.runNow()).toMatchObject({embedded:4});
  } finally {lock.release();await scheduler.stop();rmSync(root,{recursive:true,force:true});}
});

test("indexed pending tail rows bypass a covered prefix in a single batch", async () => {
  const {root,cfg}=setup();const db=openIndex(cfg.indexPath),session=fixture();
  session.messages=Array.from({length:26},(_,i)=>({...session.messages[0],id:`m${i}`,text:`words ${i}`}));
  indexSession(db,session);
  const {putTextVector}=await import("../src/indexer/vector-store");
  for(const message of session.messages.slice(0,25)) putTextVector(db,{session_id:session.id,message_id:message.id,
    provider_kind:"test",provider_model:"m",dimension:2,embedding:[1,0],text:message.text,title:session.title,
    role:message.role,created_at:message.created_at,source:session.source});
  db.close();let calls=0;
  const scheduler=startEmbeddingBackfillScheduler({cfg,scanLimit:10,now:()=>1_000_000,
    provider:{...p,embed:async()=>{calls++;return [1,0];}}});
  try {
    expect(await scheduler.runNow()).toMatchObject({embedded:1,attempted:1,scan:{scanned:1,exhausted:true}});
    expect(scheduler.status().next_run_at).toBe(new Date(1_600_000).toISOString());expect(calls).toBe(1);
    expect(await scheduler.runNow()).toMatchObject({attempted:0});expect(calls).toBe(1);
  } finally {await scheduler.stop();rmSync(root,{recursive:true,force:true});}
});

test("a failing item does not hold the cursor ahead of later healthy pending messages", async () => {
  const {root,cfg}=setup();const sent:string[]=[];
  const scheduler=startEmbeddingBackfillScheduler({cfg,provider:{...p,embed:async text=>{
    sent.push(text);if(text==="words 0")throw new Error("bad item");return [1,0];
  }}});
  try {
    expect(await scheduler.runNow()).toMatchObject({embedded:3,deferred:1,provider_outage:false});
    expect(sent).toEqual(["words 3","words 2","words 1","words 0"]);
    expect(scheduler.status()).toMatchObject({state:"scheduled",consecutive_failures:0});
    expect(await scheduler.runNow()).toMatchObject({attempted:0});expect(sent).toHaveLength(4);
  } finally {await scheduler.stop();rmSync(root,{recursive:true,force:true});}
});

test("cleanup failures are contained in scheduler status instead of rejecting a timer run", async () => {
  const {Database}=await import("bun:sqlite"),{spyOn}=await import("bun:test");
  const {root,cfg}=setup(),original=Database.prototype.run;
  const remove=spyOn(Database.prototype,"run").mockImplementation(function(this:InstanceType<typeof Database>,...args:Parameters<typeof original>) {
    if(String(args[0]).startsWith("DELETE FROM locks")) throw new Error("private cleanup error");
    return original.apply(this,args);
  });
  const scheduler=startEmbeddingBackfillScheduler({cfg,provider:p});
  try {
    expect(await scheduler.runNow()).toBeNull();
    expect(scheduler.status()).toMatchObject({running:false,state:"backoff",last_run:{outcome:"failed"}});
    expect(JSON.stringify(scheduler.status())).not.toContain("private cleanup");
  } finally {remove.mockRestore();await scheduler.stop();rmSync(root,{recursive:true,force:true});}
});

test("expired leases are recovered and reported in background backfill status", async () => {
  const {acquireBackfillLock}=await import("../src/indexer/backfill-lock");
  const {root,cfg}=setup(),dead=acquireBackfillLock(cfg.indexPath,{now:()=>1000})!;
  const scheduler=startEmbeddingBackfillScheduler({cfg,provider:p});
  try {
    expect(await scheduler.runNow()).toMatchObject({embedded:4,lease:{recovered:true,recoveries:1}});
    expect(scheduler.status()).toMatchObject({lease:{state:"released",recovered:true,recoveries:1},last_run:{outcome:"complete",lease:{recovered:true}}});
    dead.release();
    expect(await scheduler.runNow()).toMatchObject({attempted:0});
  } finally {dead.release();await scheduler.stop();rmSync(root,{recursive:true,force:true});}
});

test("a displaced scheduler aborts inference and reports a lost lease instead of writing", async () => {
  const {root,cfg}=setup();
  const scheduler=startEmbeddingBackfillScheduler({cfg,provider:{...p,embed:async()=>{
    const db=openIndex(cfg.indexPath);
    try {db.run("UPDATE locks SET owner_token='replacement'");} finally {db.close();}
    return [1,0];
  }}});
  try {
    expect(await scheduler.runNow()).toBeNull();
    expect(scheduler.status()).toMatchObject({lease:{state:"lost"},last_run:{outcome:"lease_lost"}});
    const db=openIndex(cfg.indexPath);
    try {expect(db.query("SELECT * FROM message_vectors").all()).toHaveLength(0);}
    finally {db.close();}
  } finally {await scheduler.stop();rmSync(root,{recursive:true,force:true});}
});

test("scheduled ticks recover a crashed lease without a manual run or cleanup", async () => {
  const {acquireBackfillLock}=await import("../src/indexer/backfill-lock");
  const {root,cfg}=setup(),dead=acquireBackfillLock(cfg.indexPath,{now:()=>1000})!;
  let entered!:()=>void;const called=new Promise<void>(resolve=>{entered=resolve;});
  const scheduler=startEmbeddingBackfillScheduler({cfg:{...cfg,embeddingBackfillIntervalMs:20,embeddingBackfillBatchSize:1},
    provider:{...p,embed:async()=>{entered();return [1,0];}}});
  let watchdog:ReturnType<typeof setTimeout>|undefined;
  try {
    await Promise.race([called,new Promise<never>((_,reject)=>{watchdog=setTimeout(()=>reject(new Error("automatic recovery did not run")),2000);})]);
    expect(scheduler.status().lease).toMatchObject({recovered:true,recoveries:1});
    await scheduler.stop();
    expect(scheduler.status().last_run!.lease).toMatchObject({recovered:true});
  } finally {clearTimeout(watchdog);dead.release();await scheduler.stop();rmSync(root,{recursive:true,force:true});}
});

test('background batches honor the configurable skipped timer and recover with no global backoff',async()=> {
 const {spyOn}=await import('bun:test');
 const {root,cfg}=setup();let clock=1000,broken=true;
 const now=spyOn(Date,'now').mockImplementation(()=>clock);
 const scheduler=startEmbeddingBackfillScheduler({cfg:{...cfg,embeddingSkippedRetryMs:1000},provider:{...p,embed:async()=>{
  if(broken)throw new DOMException('private','TimeoutError');return [1,0];
 }}});
 try {
  for(const time of [1000,121000,361000]) {clock=time;await scheduler.runNow();}
  expect(scheduler.status()).toMatchObject({consecutive_failures:0,progress:{queue:{skipped:4}}});
  broken=false;clock=361999;expect(await scheduler.runNow()).toMatchObject({attempted:0});
  clock=362000;expect(await scheduler.runNow()).toMatchObject({embedded:4,queue:{skipped:0}});
 }finally{await scheduler.stop();now.mockRestore();rmSync(root,{recursive:true,force:true});}
});
