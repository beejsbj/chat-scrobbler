import { test, expect } from "bun:test";
import { openIndex, indexSession } from "../src/indexer/sqlite";
import { embedBackfill, textCoverage } from "../src/indexer/embed-backfill";
import { fixture } from "./support/embedding-fixture";
const p = { kind: "test", model: "m", dimensions: 2, embed: async () => [1,0] };
test("backfill limit, resume, throttle, load pause, and title invalidation", async () => {
  const db = openIndex(":memory:");
  try {
    const s = fixture(); s.messages.push({ ...s.messages[0], id: "m2", text: "second" }); indexSession(db,s);
    let loadCalls = 0, calls = 0; const sleeps: number[] = [], progress: any[] = [];
    const opts = { provider: { ...p, embed: async () => { calls++; return [1,0]; } }, rate: 2, loadThreshold: 8, load: () => loadCalls++ === 0 ? 9 : 0, sleep: async (ms: number) => { sleeps.push(ms); }, progress: (report: any) => progress.push(report) };
    expect(await embedBackfill(db, { ...opts, limit: 1 })).toMatchObject({ embedded: 1, text: { total: 2, embedded: 1 } });
    expect(sleeps).toContain(5000);
    expect(await embedBackfill(db, opts)).toMatchObject({ embedded: 1, skipped: 1, text: { total: 2, embedded: 2 } });
    expect(await embedBackfill(db, opts)).toMatchObject({ embedded: 0, skipped: 2 });
    expect(calls).toBe(2); expect(progress.some(x => x.event === "load_pause")).toBe(true);
    s.title = "changed"; indexSession(db,s);
    expect(textCoverage(db,p)).toEqual({ total: 2, embedded: 0 });
    await embedBackfill(db,opts); expect(calls).toBe(4);
    expect(sleeps).toContain(500);
  } finally { db.close(); }
});
test("backfill commits each message, continues after failure, and rejects a stale write", async () => {
  const db = openIndex(":memory:");
  try {
    const s = fixture(); s.messages.push({ ...s.messages[0], id: "m2", text: "second" }); indexSession(db,s);
    const report = await embedBackfill(db, { provider: { ...p, embed: async text => { if (text === "archived words") throw new Error("private text"); return [1,0]; } }, load: () => 0, sleep: async () => {} });
    expect(report).toMatchObject({ failed: 1, embedded: 1, text: { embedded: 1 } });
    const stale = await embedBackfill(db, { provider: { ...p, embed: async () => { indexSession(db, fixture("newer text")); return [1,0]; } }, load: () => 0, sleep: async () => {}, limit: 1 });
    expect(stale).toMatchObject({ stale: 1, embedded: 0 });
  } finally { db.close(); }
});
test("invalid backfill controls fail before inference and cancellation interrupts load pause", async () => {
  const db = openIndex(":memory:");
  try {
    indexSession(db, fixture());
    for (const rate of [0, -1, NaN, Infinity]) expect(embedBackfill(db,{ provider:p,rate })).rejects.toThrow();
    const abort = new AbortController();
    expect(embedBackfill(db,{ provider:p,loadThreshold:8,load:()=>9,signal:abort.signal,sleep:async()=>abort.abort() })).rejects.toThrow();
  } finally { db.close(); }
});

test("deleted queued messages never reach inference", async () => {
  const {deleteIndexedSession}=await import("../src/indexer/sqlite");const db=openIndex(":memory:");
  try {
    const s=fixture();s.messages.push({...s.messages[0],id:"second",text:"must not send"});indexSession(db,s);
    const calls:string[]=[];await embedBackfill(db,{provider:{...p,embed:async text=>{calls.push(text);deleteIndexedSession(db,"chatgpt","test");return[1,0];}},load:()=>0,sleep:async()=>{}});
    expect(calls).toEqual(["archived words"]);
  } finally {db.close();}
});
test("normal backfill limits work and leaves unrelated legacy models unconverted", async () => {
  const db=openIndex(":memory:");
  try {
    indexSession(db,fixture());
    for(let i=0;i<3;i++) db.run(`INSERT INTO message_embeddings(session_id,message_id,embedding,text,provider_kind,provider_model,dimension) VALUES (?,?,?,?,?,?,?)`,["old",`m${i}`,"[1,0]","old","test","another-model",2]);
    await embedBackfill(db,{provider:p,limit:1,load:()=>0,sleep:async()=>{}});
    expect(db.query("SELECT * FROM message_vectors WHERE provider_model='another-model'").all()).toHaveLength(0);
  } finally {db.close();}
});
test("backfill rejects a provider's declared dimension mismatch", async () => {
  const db=openIndex(":memory:");
  try {indexSession(db,fixture());expect(await embedBackfill(db,{provider:{...p,embed:async()=>[1,0,0]},load:()=>0,sleep:async()=>{}})).toMatchObject({embedded:0,failed:1});expect(db.query("SELECT * FROM message_vectors").all()).toHaveLength(0);}
  finally {db.close();}
});

test("a deletion during the per-request load wait prevents dispatch", async () => {
  const {deleteIndexedSession}=await import("../src/indexer/sqlite");const db=openIndex(":memory:");
  try {
    indexSession(db,fixture());let checks=0,dispatched=0;
    const report=await embedBackfill(db,{provider:{...p,embed:async(_text,context)=>{await context?.beforeRequest?.();dispatched++;return[1,0];}},loadThreshold:8,load:()=>++checks===3 ? 9 : 0,sleep:async()=>{deleteIndexedSession(db,"chatgpt","test");}});
    expect(dispatched).toBe(0);expect(report.stale).toBe(1);
  } finally {db.close();}
});
test("limit includes lazy legacy conversions and those writes wait for low load", async () => {
  const db=openIndex(":memory:");
  try {
    const s=fixture();s.messages.push({...s.messages[0],id:"m2",text:"second"});indexSession(db,s);
    for(const m of s.messages)db.run(`INSERT INTO message_embeddings(session_id,message_id,embedding,text,title,role,source,provider_kind,provider_model,dimension) VALUES (?,?,?,?,?,?,?,?,?,?)`,[s.id,m.id,"[1,0]",m.text,"T","user","chatgpt","test","m",2]);
    let checks=0,paused=false;
    const report=await embedBackfill(db,{provider:{...p,embed:async()=>{throw new Error("legacy reuse");}},limit:1,rate:1,loadThreshold:8,load:()=>++checks===2 ? 9 : 0,sleep:async ms=>{if(ms===5000){expect(db.query("SELECT * FROM message_vectors").all()).toHaveLength(0);paused=true;}}});
    expect(paused).toBe(true);expect(report.attempted).toBe(1);expect(db.query("SELECT * FROM message_vectors").all()).toHaveLength(1);
  } finally {db.close();}
});
test("coverage excludes nonfinite text blobs with valid byte lengths", async () => {
  const db=openIndex(":memory:");
  try {indexSession(db,fixture());
    await embedBackfill(db,{provider:p,load:()=>0,sleep:async()=>{}});
    db.run("UPDATE message_vectors SET embedding=?",[new Uint8Array(new Float32Array([NaN,0]).buffer)]);
    expect(textCoverage(db,p).embedded).toBe(0);
  } finally {db.close();}
});

test("backfill counts empty and whitespace messages as skipped without inference or consuming the limit", async () => {
  const db = openIndex(":memory:");
  try {
    const session = fixture("");
    session.messages.push({ ...session.messages[0], id: "blank", text: " \t\r\n\u00a0\u2003" });
    session.messages.push({ ...session.messages[0], id: "body", text: "actual notes" });
    indexSession(db, session);
    // Older indexes can contain empty rows even though current ingestion omits them.
    db.run("INSERT INTO messages_fts(text,message_id,session_id,title) VALUES ('','empty',?,'T')", [session.id]);
    const sent: string[] = [];
    expect(textCoverage(db, p)).toEqual({ total: 1, embedded: 0 });
    const report = await embedBackfill(db, {
      provider: { ...p, embed: async text => { sent.push(text); return [1, 0]; } },
      limit: 1, sleep: async () => {},
    });
    expect(sent).toEqual(["actual notes"]);
    expect(report).toMatchObject({ skipped: 2, attempted: 1, embedded: 1, text: { total: 1, embedded: 1 } });
  } finally { db.close(); }
});

test("coverage excludes cached whitespace vectors in both binary and legacy stores", async () => {
  const { putTextVector } = await import("../src/indexer/vector-store");
  const db = openIndex(":memory:");
  try {
    const session = fixture(" \t\n");
    indexSession(db, session);
    const row = { session_id: session.id, message_id: session.messages[0].id, text: " \t\n", title: "T",
      role: "user", created_at: null, source: "chatgpt", provider_kind: "test", provider_model: "m", dimension: 2 };
    db.run(`INSERT INTO message_embeddings(session_id,message_id,embedding,text,title,provider_kind,provider_model,dimension)
      VALUES (?,?,?,?,?,?,?,?)`, [row.session_id,row.message_id,"[1,0]",row.text,row.title,"test","m",2]);
    expect(textCoverage(db, p)).toEqual({ total: 0, embedded: 0 });
    putTextVector(db, { ...row, embedding: [1, 0] });
    expect(textCoverage(db, p)).toEqual({ total: 0, embedded: 0 });
  } finally { db.close(); }
});

test("backfill ignores host load by default and yields 100 ms between serial requests", async () => {
  const db = openIndex(":memory:");
  try {
    const session = fixture();
    session.messages.push({ ...session.messages[0], id: "second", text: "second" });
    indexSession(db, session);
    let loadChecks = 0;
    const sleeps: number[] = [];
    const sent: string[] = [];
    const report = await embedBackfill(db, {
      provider: { ...p, embed: async text => { sent.push(text); return [1, 0]; } },
      load: () => { loadChecks++; return 32; },
      sleep: async ms => { sleeps.push(ms); if (ms === 5000) throw new Error("unexpected load brake"); },
    });
    expect(report.embedded).toBe(2);
    expect(loadChecks).toBe(0);
    expect(sent).toEqual(["archived words", "second"]);
    expect(sleeps).toEqual([100]);
  } finally { db.close(); }
});

test("coverage and backfill populate the deferred legacy message lookup", async () => {
  const db = openIndex(":memory:");
  try {
    indexSession(db, fixture());
    await embedBackfill(db, { provider: p, sleep: async () => {} });
    db.run("DELETE FROM message_lookup");
    db.run("UPDATE message_lookup_state SET cursor=0,ready=0 WHERE id=1");
    expect(textCoverage(db, p)).toEqual({ total: 1, embedded: 1 });
    db.run("DELETE FROM message_lookup");
    db.run("UPDATE message_lookup_state SET cursor=0,ready=0 WHERE id=1");
    const sent: string[] = [];
    const report = await embedBackfill(db, {
      provider: { ...p, model: "new", embed: async text => { sent.push(text); return [1, 0]; } }, sleep: async () => {},
    });
    expect(sent).toEqual(["archived words"]);
    expect(report).toMatchObject({ embedded: 1, text: { total: 1, embedded: 1 } });
  } finally { db.close(); }
});
