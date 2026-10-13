import { test, expect } from "bun:test";
import { openIndex, indexSession, indexSessionWithEmbeddings, searchMessages, deleteIndexedSession } from "../src/indexer/sqlite";
import { migrateLegacyVectors, decodeVector } from "../src/indexer/vector-store";

import { fixture } from "./support/embedding-fixture";
const provider = (model: string) => ({ kind: "test", model, dimensions: 2, embed: () => [1, 0] });
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
