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
    expect(await scheduler.runNow()).toMatchObject({embedded:2,attempted:2,text:null});
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

test("provider outages stop at one request, jitter exponential backoff, and retry failed work", async () => {
  const {root,cfg}=setup(); let fail=true,calls=0;
  const scheduler=startEmbeddingBackfillScheduler({cfg,random:()=>0,now:()=>1_000_000,
    provider:{...p,embed:async()=>{calls++;if(fail)throw new Error("private request body");return [1,0];}}});
  try {
    expect(await scheduler.runNow()).toMatchObject({failed:1,attempted:1});
    expect(calls).toBe(1);
    expect(scheduler.status()).toMatchObject({state:"backoff",consecutive_failures:1,last_run:{outcome:"provider_unavailable"},next_run_at:new Date(1_450_000).toISOString()});
    await scheduler.runNow(); expect(calls).toBe(2);
    expect(scheduler.status().next_run_at).toBe(new Date(1_900_000).toISOString());
    expect(JSON.stringify(scheduler.status())).not.toContain("private");
    fail=false;
    expect(await scheduler.runNow()).toMatchObject({embedded:2,attempted:2});
    // Failures advanced the cursor; the completed sweep wraps and retries them.
    expect(await scheduler.runNow()).toMatchObject({embedded:2,attempted:2});
    expect(scheduler.status()).toMatchObject({state:"scheduled",consecutive_failures:0});
  } finally {await scheduler.stop();rmSync(root,{recursive:true,force:true});}
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

test("covered prefixes continue on a short timer so pending tail rows do not wait one interval per page", async () => {
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
    expect(await scheduler.runNow()).toMatchObject({attempted:0,scan:{cursor:10,scanned:10,exhausted:false}});
    expect(scheduler.status().next_run_at).toBe(new Date(1_001_000).toISOString());
    await scheduler.runNow();expect(calls).toBe(0);
    expect(scheduler.status().next_run_at).toBe(new Date(1_001_000).toISOString());
    expect(await scheduler.runNow()).toMatchObject({embedded:1,scan:{exhausted:true}});
    expect(scheduler.status().next_run_at).toBe(new Date(1_600_000).toISOString());expect(calls).toBe(1);
  } finally {await scheduler.stop();rmSync(root,{recursive:true,force:true});}
});

test("a failing item does not hold the cursor ahead of later healthy pending messages", async () => {
  const {root,cfg}=setup();const sent:string[]=[];
  const scheduler=startEmbeddingBackfillScheduler({cfg,provider:{...p,embed:async text=>{
    sent.push(text);if(text==="words 0")throw new Error("bad item");return [1,0];
  }}});
  try {
    await scheduler.runNow();expect(sent).toEqual(["words 0"]);
    expect(await scheduler.runNow()).toMatchObject({embedded:3,failed:0,scan:{exhausted:true}});
    await scheduler.runNow();expect(sent.at(-1)).toBe("words 0");
  } finally {await scheduler.stop();rmSync(root,{recursive:true,force:true});}
});

test("cleanup failures are contained in scheduler status instead of rejecting a timer run", async () => {
  const fs=await import("node:fs"),{spyOn}=await import("bun:test");
  const {root,cfg}=setup(),original=fs.rmdirSync;
  const remove=spyOn(fs,"rmdirSync").mockImplementation(((path:Parameters<typeof fs.rmdirSync>[0],...args:unknown[])=> {
    if(String(path).endsWith(".embed-backfill.lock")) throw new Error("private cleanup error");
    return original(path,...args as []);
  }) as typeof fs.rmdirSync);
  const scheduler=startEmbeddingBackfillScheduler({cfg,provider:p});
  try {
    expect(await scheduler.runNow()).toBeNull();
    expect(scheduler.status()).toMatchObject({running:false,state:"backoff",last_run:{outcome:"failed"}});
    expect(JSON.stringify(scheduler.status())).not.toContain("private cleanup");
  } finally {remove.mockRestore();await scheduler.stop();rmSync(root,{recursive:true,force:true});}
});
