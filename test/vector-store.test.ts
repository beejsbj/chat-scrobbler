import { test, expect } from "bun:test";
import { openIndex, indexSession, indexSessionWithEmbeddings, searchMessages, deleteIndexedSession } from "../src/indexer/sqlite";
import { migrateLegacyVectors, decodeVector } from "../src/indexer/vector-store";

import { fixture } from "./support/embedding-fixture";
const provider = (model: string) => ({ kind: "test", model, dimensions: 2, embed: () => [1, 0] });
test("new model sets store a digest instead of another copy of chat text", async () => {
  const db=openIndex(":memory:");
  try {
    const p=provider("digest");
    await indexSessionWithEmbeddings(db,fixture(),{embeddingProvider:p});
    const row=db.query("SELECT text,text_hash FROM message_vectors").get() as any;
    expect(row.text).toBe(""); expect(row.text_hash).toHaveLength(64);
    expect(searchMessages(db,"unmatched",{embeddingProvider:p})).toHaveLength(1);
    indexSession(db,fixture("edited"));
    expect(searchMessages(db,"unmatched",{embeddingProvider:p})).toEqual([]);
  } finally {db.close();}
});
test("binary vectors coexist across models, reuse after switching, and scope search", async () => {
  const db = openIndex(":memory:");
  try {
    let calls = 0;
    const a = { ...provider("a"), embed: () => { calls++; return [1, 0]; } };
    await indexSessionWithEmbeddings(db, fixture(), { embeddingProvider: a });
    await indexSessionWithEmbeddings(db, fixture(), { embeddingProvider: provider("b") });
    await indexSessionWithEmbeddings(db, fixture(), { embeddingProvider: a });
    expect(calls).toBe(1);
    const rows = db.query("SELECT embedding, typeof(embedding) AS type FROM message_vectors").all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].type).toBe("blob");
    expect(rows[0].embedding.byteLength).toBe(8);
    expect(Array.from(decodeVector(rows[0].embedding, 2))).toEqual([1, 0]);
    expect(searchMessages(db, "unmatched", { embeddingProvider: provider("missing") })).toEqual([]);
    expect(searchMessages(db, "unmatched", { embeddingProvider: a })).toHaveLength(1);
    deleteIndexedSession(db, "chatgpt", "test");
    expect(db.query("SELECT * FROM message_vectors").all()).toEqual([]);
  } finally { db.close(); }
});
test("legacy JSON conversion is bounded, resumable and preserves all source rows", () => {
  const db = openIndex(":memory:");
  try {
    indexSession(db, fixture());
    for (let i = 0; i < 3; i++) db.run(`INSERT INTO message_embeddings(session_id,message_id,embedding,text,title,provider_kind,provider_model,dimension) VALUES (?,?,?,?,?,?,?,?)`, ["chatgpt:test", `m${i}`, i === 1 ? "bad-json" : "[1,0]", "archived words", "T", "test", "legacy", 2]);
    expect(migrateLegacyVectors(db, { limit: 1 })).toMatchObject({ scanned: 1, converted: 1, cursor: 1 });
    expect(migrateLegacyVectors(db, { limit: 1 })).toMatchObject({ scanned: 1, converted: 0, invalid: 1, cursor: 2 });
    expect(migrateLegacyVectors(db, { limit: 1 })).toMatchObject({ scanned: 1, converted: 1, cursor: 3 });
    expect(migrateLegacyVectors(db, { limit: 1 }).scanned).toBe(0);
    expect(db.query("SELECT * FROM message_embeddings").all()).toHaveLength(3);
    expect(db.query("SELECT * FROM message_vectors").all()).toHaveLength(2);
  } finally { db.close(); }
});
test("unconverted legacy vectors remain searchable and are reused without model calls", async () => {
  const db = openIndex(":memory:");
  try {
    indexSession(db, fixture());
    db.run(`INSERT INTO message_embeddings(session_id,message_id,embedding,text,title,role,source,provider_kind,provider_model,dimension) VALUES (?,?,?,?,?,?,?,?,?,?)`, ["chatgpt:test", "m", "[1,0]", "archived words", "T", "user", "chatgpt", "test", "legacy", 2]);
    expect(searchMessages(db, "unmatched", { embeddingProvider: provider("legacy") })).toHaveLength(1);
    await indexSessionWithEmbeddings(db, fixture(), { embeddingProvider: { ...provider("legacy"), embed: () => { throw new Error("should reuse"); } } });
    expect(db.query("SELECT * FROM message_vectors").all()).toHaveLength(1);
    expect(db.query("SELECT * FROM message_embeddings").all()).toHaveLength(1);
  } finally { db.close(); }
});
test("binary decode rejects wrong dimensions and invalid values", () => {
  expect(() => decodeVector(new Uint8Array(4), 2)).toThrow();
  expect(() => decodeVector(new Uint8Array(new Float32Array([NaN]).buffer), 1)).toThrow();
});

test("corrupt binary falls back to valid legacy and backfill repairs it without inference", async () => {
  const {embedBackfill,textCoverage}=await import("../src/indexer/embed-backfill");
  const db=openIndex(":memory:");
  try {
    const p=provider("legacy"); indexSession(db,fixture(),{embeddingProvider:p});
    db.run(`INSERT INTO message_embeddings(session_id,message_id,embedding,text,title,role,source,provider_kind,provider_model,dimension) VALUES (?,?,?,?,?,?,?,?,?,?)`,["chatgpt:test","m","[1,0]","archived words","T","user","chatgpt","test","legacy",2]);
    db.run("UPDATE message_vectors SET embedding=?",[new Uint8Array(new Float32Array([NaN,0]).buffer)]);
    expect(searchMessages(db,"unmatched",{embeddingProvider:p})).toHaveLength(1);
    await embedBackfill(db,{provider:{...p,embed:()=>{throw new Error("reuse legacy");}},load:()=>0,sleep:async()=>{}});
    expect(textCoverage(db,p).embedded).toBe(1);
    expect(Array.from(decodeVector((db.query("SELECT embedding FROM message_vectors").get() as any).embedding,2))).toEqual([1,0]);
  } finally {db.close();}
});
test("unknown provider dimensions reuse the fresh row among retained dimensions", async () => {
  const {embedBackfill}=await import("../src/indexer/embed-backfill");
  const db=openIndex(":memory:");
  try {
    const p={kind:"ollama",model:"same-model",dimensions:null,embed:()=>[1,0]};
    indexSession(db,fixture("old"),{embeddingProvider:p});
    indexSession(db,fixture(),{embeddingProvider:{...p,embed:()=>[1,0,0]}});
    let calls=0; const opts={provider:{...p,embed:()=>{calls++;return [1,0,0];}},load:()=>0,sleep:async()=>{}};
    await embedBackfill(db,opts); await embedBackfill(db,opts); expect(calls).toBe(0);
  } finally {db.close();}
});
test("stale retained model rows cannot displace live results", () => {
  const db=openIndex(":memory:"); const p=provider("old");
  try {
    for(let i=0;i<25;i++){const s=fixture(`stale ${i}`);s.id=`chatgpt:s${i}`;s.source_id=`s${i}`;indexSession(db,s,{embeddingProvider:p}); s.messages[0].text="changed";indexSession(db,s,{embeddingProvider:provider("new")});}
    indexSession(db,fixture("live result"),{embeddingProvider:p});
    expect(searchMessages(db,"unmatched",{embeddingProvider:p,limit:1})[0]?.session_id).toBe("chatgpt:test");
  } finally {db.close();}
});
