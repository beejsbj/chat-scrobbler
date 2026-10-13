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
