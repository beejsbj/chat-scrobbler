import { test, expect } from "bun:test";
import { indexSession, openIndex, searchMessages, deleteIndexedSession } from "../src/indexer/sqlite";
import { embedAsset, assetCoverage } from "../src/indexer/asset-embeddings";
import { fixture } from "./support/embedding-fixture";

const sha = "a".repeat(64);
const provider = { kind: "media", model: "m", dimensions: 2, embed: () => [1,0], embedAsset: async () => [1,0] };
function session(id = "test") { const s = fixture(""); s.id = `chatgpt:${id}`; s.source_id = id; s.messages[0].blocks = [{ type: "attachment", kind: "image", filename: "photo.png", pointer: "remote", local_path: null, sha256: sha }]; return s; }
test("one asset vector maps to multiple owners including messages without text", async () => {
  const db = openIndex(":memory:");
  try {
    indexSession(db, session()); indexSession(db, session("other"));
    let calls = 0;
    const p = { ...provider, embedAsset: async () => { calls++; return [1,0]; } };
    expect(await embedAsset(db, sha, "/tmp/synthetic", p)).toBe("indexed");
    expect(await embedAsset(db, sha, "/tmp/synthetic", p)).toBe("skipped");
    expect(calls).toBe(1);
    expect(assetCoverage(db, p)).toEqual({ total: 1, embedded: 1 });
    expect(searchMessages(db, "unmatched", { embeddingProvider: p }).map(hit => hit.session_id).sort()).toEqual(["chatgpt:other", "chatgpt:test"]);
    expect(searchMessages(db, "unmatched", { embeddingProvider: { ...p, model: "wrong" } })).toEqual([]);
    deleteIndexedSession(db, "chatgpt", "test");
    expect(db.query("SELECT * FROM asset_vectors").all()).toHaveLength(1);
    indexSession(db, fixture("attachment removed"));
    expect(searchMessages(db, "unmatched", { embeddingProvider: p })).toHaveLength(1);
    deleteIndexedSession(db, "chatgpt", "other");
    expect(db.query("SELECT * FROM asset_vectors").all()).toHaveLength(0);
  } finally { db.close(); }
});
test("asset inference cannot resurrect deleted ownership", async () => {
  const db = openIndex(":memory:");
  try {
    indexSession(db, session());
    expect(await embedAsset(db, sha, "/tmp/synthetic", { ...provider, embedAsset: async () => { deleteIndexedSession(db, "chatgpt", "test"); return [1,0]; } })).toBe("stale");
    expect(db.query("SELECT * FROM asset_vectors").all()).toHaveLength(0);
  } finally { db.close(); }
});

test("backfill repairs finite-sized corrupt asset vectors and coverage excludes them", async () => {
  const {embedBackfill}=await import("../src/indexer/embed-backfill"); const db=openIndex(":memory:");
  try {
    indexSession(db,session());await embedAsset(db,sha,"/tmp/synthetic",provider);
    db.run("UPDATE asset_vectors SET embedding=?",[new Uint8Array(new Float32Array([NaN,0]).buffer)]);
    expect(assetCoverage(db,provider)).toEqual({total:1,embedded:0});
    expect(await embedBackfill(db,{provider,canonicalDir:"/synthetic/canonical/sessions",load:()=>0,sleep:async()=>{}})).toMatchObject({embedded:1,assets:{total:1,embedded:1}});
    expect(searchMessages(db,"unmatched",{embeddingProvider:provider})).toHaveLength(1);
  } finally {db.close();}
});
test("text-only updates do not scan or prune unrelated asset hashes", async () => {
  const db=openIndex(":memory:");
  try {
    indexSession(db,session());await embedAsset(db,sha,"/tmp/synthetic",provider);
    const orphan="b".repeat(64);db.run("INSERT INTO asset_vectors VALUES (?,?,?,?,?)",[orphan,"media","m",2,new Uint8Array(new Float32Array([1,0]).buffer)]);
    indexSession(db,fixture("attachment removed"));
    expect((db.query("SELECT sha256 FROM asset_vectors").all() as any[]).map(row=>row.sha256)).toEqual([orphan]);
  } finally {db.close();}
});
