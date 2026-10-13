import { test, expect } from "bun:test";
import { openIndex, indexSession } from "../src/indexer/sqlite";
import { embedBackfill, textCoverage } from "../src/indexer/embed-backfill";
import { fixture } from "./support/embedding-fixture";
import { EmbeddingGemmaProvider } from "../src/indexer/embedding-providers";
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

test("an old writer reusing an FTS rowid for another identity during inference cannot resurrect a vector", async () => {
  for (const replacement of [
    { session_id:"chatgpt:replacement", message_id:"m" },
    { session_id:"chatgpt:test", message_id:"replacement" },
  ]) {
    const db=openIndex(":memory:");
    try {
      const session=fixture();
      indexSession(db,session);
      const report=await embedBackfill(db,{
        provider:{...p,embed:async text=> {
          const row=db.query("SELECT rowid FROM messages_fts WHERE session_id=? AND message_id=?")
            .get(session.id,session.messages[0].id) as {rowid:number};
          // Simulate an old binary writing raw FTS while its lookup stays stale.
          db.run("DELETE FROM messages_fts WHERE rowid=?",[row.rowid]);
          db.run(`INSERT INTO messages_fts(rowid,text,message_id,session_id,role,created_at,source,title)
            VALUES (?,?,?,?,?,?,?,?)`,[row.rowid,text,replacement.message_id,replacement.session_id,"user",null,"chatgpt",session.title]);
          return [1,0];
        }},
        limit:1,sleep:async()=>{},
      });
      expect(report).toMatchObject({stale:1,embedded:0,converted:0,failed:0});
      expect(db.query("SELECT COUNT(*) AS total FROM message_vectors").get()).toEqual({total:0});
    } finally {db.close();}
  }
});

test("coverage rejects binary and legacy vectors attached to an FTS rowid reused by another identity", async () => {
  for (const store of ["binary","legacy"]) {
    const db=openIndex(":memory:");
    try {
      const session=fixture();
      indexSession(db,session);
      if (store === "binary") await embedBackfill(db,{provider:p,sleep:async()=>{}});
      else db.run(`INSERT INTO message_embeddings(session_id,message_id,embedding,text,title,provider_kind,provider_model,dimension)
        VALUES (?,?,?,?,?,?,?,?)`,[session.id,session.messages[0].id,"[1,0]",session.messages[0].text,session.title,"test","m",2]);
      expect(textCoverage(db,p)).toEqual({total:1,embedded:1});
      const row=db.query("SELECT rowid FROM messages_fts").get() as {rowid:number};
      db.run("DELETE FROM messages_fts WHERE rowid=?",[row.rowid]);
      db.run(`INSERT INTO messages_fts(rowid,text,message_id,session_id,role,created_at,source,title)
        VALUES (?,?,?,?,?,?,?,?)`,[row.rowid,session.messages[0].text,"replacement","chatgpt:replacement","user",null,"chatgpt",session.title]);
      expect(textCoverage(db,p)).toEqual({total:1,embedded:0});
    } finally {db.close();}
  }
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
    const report=await embedBackfill(db,{provider:{...p,embed:async(_text,context)=>{await context?.beforeRequest?.();dispatched++;return[1,0];}},loadThreshold:8,load:()=>++checks===2 ? 9 : 0,sleep:async()=>{deleteIndexedSession(db,"chatgpt","test");}});
    expect(dispatched).toBe(0);expect(report).toMatchObject({ stale:1, requests:0, mean_request_seconds:null });
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

test("backfill reports chunk work and ETA while yielding between every serial chunk", async () => {
  const db = openIndex(":memory:");
  const originalFetch = globalThis.fetch;
  try {
    const session = fixture("x".repeat(9000));
    session.messages.push({ ...session.messages[0], id: "second", text: "short notes" });
    indexSession(db, session);
    let clock = 0, active = 0, maxActive = 0;
    const dispatched: number[] = [], sleeps: number[] = [], progress: any[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit) => {
      dispatched.push(clock);
      active++;
      maxActive = Math.max(maxActive, active);
      clock += 2000;
      active--;
      return new Response(JSON.stringify({ data: [{ embedding: new Array(768).fill(0.25) }] }));
    }) as typeof fetch;
    const provider = new EmbeddingGemmaProvider({ baseUrl: "http://fixture.invalid", model: "test" });
    const report = await embedBackfill(db, {
      provider, now: () => clock, sleep: async ms => { sleeps.push(ms); clock += ms; },
      progress: report => progress.push(report),
    });
    expect(progress[0]).toMatchObject({ estimated_requests: 3, remaining_requests: 3, estimated_compute_chunks: 7, remaining_compute_chunks: 7, requests: 0, eta_basis: "assumed_2s_per_compute_chunk" });
    expect(progress[0].eta_seconds).toBeCloseTo(14.3, 8);
    expect(report).toMatchObject({ embedded: 2, requests: 3, remaining_requests: 0, elapsed_seconds: 6.2, mean_request_seconds: 2, eta_seconds: 0, eta_basis: "observed" });
    expect(dispatched).toEqual([0, 2100, 4200]);
    expect(sleeps).toEqual([100, 100]);
    expect(maxActive).toBe(1);
  } finally { globalThis.fetch = originalFetch; db.close(); }
});

test("ETA excludes cached vectors, legacy conversions, and blank messages from inference work", async () => {
  const db = openIndex(":memory:");
  try {
    indexSession(db, fixture());
    await embedBackfill(db, { provider: p, sleep: async () => {} });
    const session = fixture();
    session.messages.push({ ...session.messages[0], id: "legacy", text: "legacy notes" });
    session.messages.push({ ...session.messages[0], id: "blank", text: " \n\t" });
    indexSession(db, session);
    db.run(`INSERT INTO message_embeddings(session_id,message_id,embedding,text,title,provider_kind,provider_model,dimension)
      VALUES ('chatgpt:test','legacy','[1,0]','legacy notes','T','test','m',2)`);
    const report = await embedBackfill(db, {
      provider: { ...p, embed: async () => { throw new Error("no inference expected"); } }, sleep: async () => {},
    });
    expect(report).toMatchObject({ converted: 1, skipped: 2, estimated_requests: 0, remaining_requests: 0, requests: 0, eta_seconds: 0 });
  } finally { db.close(); }
});

test("failed document chunks remain in the ETA for a whole-document retry", async () => {
  const db = openIndex(":memory:");
  const originalFetch = globalThis.fetch;
  try {
    indexSession(db, fixture("x".repeat(9000)));
    let calls = 0;
    globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit) => ++calls === 1
      ? new Response(JSON.stringify({ data: [{ embedding: new Array(768).fill(0.25) }] }))
      : new Response("fixture unavailable", { status: 503 })) as typeof fetch;
    const provider = new EmbeddingGemmaProvider({ baseUrl: "http://fixture.invalid", model: "test" });
    const report = await embedBackfill(db, { provider, sleep: async () => {} });
    expect(report).toMatchObject({ failed: 1, embedded: 0, requests: 2, estimated_requests: 2, remaining_requests: 2, text: { total: 1, embedded: 0 } });
  } finally { globalThis.fetch = originalFetch; db.close(); }
});

test("deleting a document during a chunk pacing yield stops remaining dispatches", async () => {
  const { deleteIndexedSession } = await import("../src/indexer/sqlite");
  const db = openIndex(":memory:");
  const originalFetch = globalThis.fetch;
  try {
    indexSession(db, fixture("x".repeat(9000)));
    let calls = 0;
    globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit) => {
      calls++;
      return new Response(JSON.stringify({ data: [{ embedding: new Array(768).fill(0.25) }] }));
    }) as typeof fetch;
    const provider = new EmbeddingGemmaProvider({ baseUrl: "http://fixture.invalid", model: "test" });
    const report = await embedBackfill(db, { provider, sleep: async () => { deleteIndexedSession(db, "chatgpt", "test"); } });
    expect(calls).toBe(1);
    expect(report).toMatchObject({ stale: 1, embedded: 0, failed: 0, requests: 1 });
    expect(textCoverage(db, provider)).toEqual({ total: 0, embedded: 0 });
  } finally { globalThis.fetch = originalFetch; db.close(); }
});

test("ETA measures request latency without counting emergency host load pauses", async () => {
  const db = openIndex(":memory:");
  try {
    const session = fixture();
    session.messages.push({ ...session.messages[0], id: "second", text: "second" });
    indexSession(db, session);
    let clock = 0, checks = 0;
    const report = await embedBackfill(db, {
      provider: { ...p, embed: async () => { clock += 2000; return [1, 0]; } },
      now: () => clock, loadThreshold: 32, load: () => checks++ === 0 ? 33 : 0,
      sleep: async ms => { clock += ms; }, limit: 1,
    });
    expect(report).toMatchObject({ estimated_requests: 2, remaining_requests: 1, requests: 1, elapsed_seconds: 7, mean_request_seconds: 2, eta_basis: "observed" });
    expect(report.eta_seconds).toBeCloseTo(2.1, 8);
  } finally { db.close(); }
});

test("an explicit emergency load brake runs before lookup and coverage preparation", async () => {
  const db = openIndex(":memory:");
  try {
    indexSession(db, fixture());
    db.run("DELETE FROM message_lookup");
    db.run("UPDATE message_lookup_state SET cursor=0,ready=0 WHERE id=1");
    let checks = 0;
    const pauses: any[] = [];
    const report = await embedBackfill(db, {
      provider: p, loadThreshold: 32, load: () => checks++ === 0 ? 33 : 0,
      sleep: async () => {
        expect(db.query("SELECT ready FROM message_lookup_state").get()).toEqual({ ready: 0 });
        expect(db.query("SELECT * FROM message_lookup").all()).toHaveLength(0);
      },
      progress: report => { if (report.event === "load_pause") pauses.push(report); },
    });
    expect(pauses[0]).toMatchObject({ text: null, assets: null, estimated_requests: null, eta_seconds: null });
    expect(report.embedded).toBe(1);
  } finally { db.close(); }
});

test("a load pause deleting a document before its first HTTP dispatch does not count or sample a request", async () => {
  const { deleteIndexedSession } = await import("../src/indexer/sqlite");
  const db = openIndex(":memory:");
  const originalFetch = globalThis.fetch;
  try {
    indexSession(db, fixture());
    let clock = 0, dispatched = 0, pauseNext = false;
    globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit) => {
      dispatched++;
      return new Response(JSON.stringify({ data: [{ embedding: new Array(768).fill(0.25) }] }));
    }) as typeof fetch;
    const provider = new class extends EmbeddingGemmaProvider {
      override embed(text: string, context?: Parameters<EmbeddingGemmaProvider["embed"]>[1]) {
        // Load rises when inference is entered, before the provider's dispatch hook.
        pauseNext = true;
        return super.embed(text, context);
      }
    }({ baseUrl: "http://fixture.invalid", model: "test" });
    const report = await embedBackfill(db, {
      provider, now: () => clock, loadThreshold: 32,
      load: () => { if (!pauseNext) return 0; pauseNext = false; return 33; },
      sleep: async ms => { clock += ms; deleteIndexedSession(db, "chatgpt", "test"); },
    });
    expect(dispatched).toBe(0);
    expect(report).toMatchObject({ stale: 1, requests: 0, mean_request_seconds: null, eta_basis: "assumed_2s_per_compute_chunk" });
  } finally { globalThis.fetch = originalFetch; db.close(); }
});

test("a fast HTTP failure preserves the initial native chunk ETA until a successful response", async () => {
  const db = openIndex(":memory:");
  const originalFetch = globalThis.fetch;
  try {
    const session = fixture("x".repeat(9000));
    session.messages.push({ ...session.messages[0], id:"second", text:"short" });
    indexSession(db,session);
    let clock=0;
    globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit) => {
      clock+=10;
      return new Response("unavailable",{status:503});
    }) as typeof fetch;
    const provider = new EmbeddingGemmaProvider({ baseUrl:"http://fixture.invalid", model:"test" });
    const report = await embedBackfill(db,{provider,limit:1,now:()=>clock,sleep:async ms=>{clock+=ms;}});
    expect(report).toMatchObject({ failed:1, requests:1, remaining_requests:3, mean_request_seconds:null, eta_basis:"assumed_2s_per_compute_chunk" });
    expect(report.eta_seconds).toBeCloseTo(14.3,8);
  } finally { globalThis.fetch=originalFetch; db.close(); }
});

test("generic providers without dispatch hooks count calls but sample only successful vectors", async () => {
  const db=openIndex(":memory:");
  try {
    const session=fixture();
    session.messages.push({...session.messages[0],id:"second",text:"second"});
    indexSession(db,session);
    let clock=0;
    const report=await embedBackfill(db,{
      provider:{...p,embed:async text=> {
        if (text === "archived words") { clock+=10; throw new Error("unavailable"); }
        clock+=2000; return [1,0];
      }},
      now:()=>clock,sleep:async ms=>{clock+=ms;},
    });
    expect(report).toMatchObject({ failed:1, embedded:1, requests:2, mean_request_seconds:2, remaining_requests:1, eta_basis:"observed" });
    expect(report.eta_seconds).toBeCloseTo(2.1,8);
  } finally {db.close();}
});

test("deleting an asset during its pacing yield does not count or sample a media request", async () => {
  const {deleteIndexedSession}=await import("../src/indexer/sqlite");
  const db=openIndex(":memory:");
  const originalFetch=globalThis.fetch;
  try {
    const session=fixture();
    session.messages[0].blocks=[{type:"attachment",kind:"image",filename:"fixture.png",pointer:"fixture",local_path:null,sha256:"a".repeat(64)}];
    indexSession(db,session);
    let clock=0,dispatched=0;
    globalThis.fetch=(async (_url: string | URL | Request,_init?: RequestInit)=> {
      dispatched++; clock+=2000;
      return new Response(JSON.stringify({data:[{embedding:new Array(768).fill(0.25)}]}));
    }) as typeof fetch;
    const provider=new EmbeddingGemmaProvider({baseUrl:"http://fixture.invalid",model:"test"});
    const report=await embedBackfill(db,{
      provider,canonicalDir:"/synthetic/canonical/sessions",now:()=>clock,
      sleep:async ms=>{clock+=ms;deleteIndexedSession(db,"chatgpt","test");},
    });
    expect(dispatched).toBe(1);
    expect(report).toMatchObject({embedded:1,stale:1,failed:0,requests:1,mean_request_seconds:2,assets:{total:0,embedded:0}});
  } finally {globalThis.fetch=originalFetch;db.close();}
});

test("background skips covered blobs, bounds scanning, yields, and resumes past a covered prefix", async () => {
  const db = openIndex(":memory:");
  try {
    const s = fixture();
    s.messages = Array.from({ length: 305 }, (_, i) => ({ ...s.messages[0], id: `m${i}`, text: `words ${i}` }));
    indexSession(db, s);
    const { putTextVector } = await import("../src/indexer/vector-store");
    for (const message of s.messages.slice(0, 300)) putTextVector(db, {
      session_id: s.id, message_id: message.id, text: message.text, title: s.title,
      role: message.role, created_at: message.created_at, source: s.source,
      provider_kind: "test", provider_model: "m", dimension: 2, embedding: [1, 0],
    });
    // A covered blob with bad coordinates proves background never decodes it.
    db.run("UPDATE message_vectors SET embedding=?", [new Uint8Array([0, 0, 192, 127, 0, 0, 0, 0])]);
    let yields = 0, calls = 0;
    const options = { provider: { ...p, embed: async () => { calls++; return [1, 0]; } }, limit: 2,
      background: { cursor: 0, scanLimit: 200 }, yieldToQueries: async () => { yields++; }, sleep: async () => {} };
    const first = await embedBackfill(db, options);
    expect(first).toMatchObject({ attempted: 0, skipped: 200, text: null, assets: null,
      scan: { cursor: 200, scanned: 200, exhausted: false } });
    expect(yields).toBeGreaterThanOrEqual(2);
    const second = await embedBackfill(db, { ...options, background: { cursor: 200, scanLimit: 200 } });
    expect(second).toMatchObject({ embedded: 2, attempted: 2, text: null,
      scan: { cursor: 302, scanned: 102, exhausted: false } });
    expect(calls).toBe(2);
  } finally { db.close(); }
});
