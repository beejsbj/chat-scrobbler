import { expect, test } from "bun:test";
import { queryPriorityProvider } from "../src/indexer/query-priority-provider";
import { EmbeddingGemmaProvider } from "../src/indexer/embedding-providers";
import { embedBackfill } from "../src/indexer/embed-backfill";
import { openIndex, indexSession } from "../src/indexer/sqlite";
import { fixture } from "./support/embedding-fixture";

test("a waiting query runs between slow document1 and queued document2", async () => {
  const order:string[]=[];let entered!:()=>void,release!:()=>void;
  const ready=new Promise<void>(resolve=>{entered=resolve;});
  const blocked=new Promise<void>(resolve=>{release=resolve;});
  const provider=queryPriorityProvider({kind:"test",model:"m",embed:async(text,context)=>{
    order.push(text);if(text==="document1"){entered();await blocked;}
    expect(context?.kind).toBe(text==="query" ? "query":"document");return [1,0];
  }});
  const first=provider.embed("document1",{kind:"document"});await ready;
  const second=provider.embed("document2",{kind:"document"});
  const query=provider.embed("query",{kind:"query"});
  release(); await Promise.all([first,second,query]);
  expect(order).toEqual(["document1","query","document2"]);
});

test("wrapped Gemma preserves native request hooks, chunk estimates, title, and signals", async () => {
  const originalFetch=globalThis.fetch,db=openIndex(":memory:");
  try {
    let calls=0;const signals:unknown[]=[];
    globalThis.fetch=(async(_url,init)=>{
      calls++; signals.push(init?.signal);
      const body=JSON.parse(init?.body as string);expect(body.role).toBe("document");expect(body.title).toBe("T");
      return new Response(JSON.stringify({data:[{embedding:new Array(768).fill(.25)}]}));
    }) as typeof fetch;
    const raw=new EmbeddingGemmaProvider({baseUrl:"http://fixture.invalid",model:"m"});
    const provider=queryPriorityProvider(raw);
    expect(provider).toBeInstanceOf(EmbeddingGemmaProvider);
    indexSession(db,fixture("x".repeat(9000)));
    const abort=new AbortController();
    const report=await embedBackfill(db,{provider,limit:1,signal:abort.signal,sleep:async()=>{},background:{cursor:0,scanLimit:100}});
    expect(report).toMatchObject({embedded:1,requests:2});expect(calls).toBe(2);
    expect(signals.every(signal=>signal instanceof AbortSignal)).toBe(true);
  } finally {globalThis.fetch=originalFetch;db.close();}
});

test("native Gemma queries dispatch while a chunked document call is still active", async () => {
  const originalFetch=globalThis.fetch,order:string[]=[];
  let enter!:()=>void,release!:()=>void;
  const entered=new Promise<void>(resolve=>{enter=resolve;});
  const blocked=new Promise<void>(resolve=>{release=resolve;});
  let document:Promise<number[]>|undefined,query:Promise<number[]>|undefined;
  try {
    globalThis.fetch=(async(_url,init)=>{
      const role=JSON.parse(init?.body as string).role;order.push(role);
      if(order.length===1){enter();await blocked;}
      return new Response(JSON.stringify({data:[{embedding:new Array(768).fill(.25)}]}));
    }) as typeof fetch;
    const raw=new EmbeddingGemmaProvider({baseUrl:"http://fixture.invalid",model:"m"});
    const provider=queryPriorityProvider(raw);
    document=Promise.resolve(provider.embed("x".repeat(9000),{kind:"document"}));await entered;
    query=Promise.resolve(provider.embed("needle",{kind:"query"}));await Bun.sleep(0);
    expect(order).toEqual(["document","query"]);
    expect(provider).toBe(raw);
  } finally {release();await Promise.all([document,query]);globalThis.fetch=originalFetch;}
});
