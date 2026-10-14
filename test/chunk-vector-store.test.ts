import { test, expect } from "bun:test";
import type { Database } from "bun:sqlite";
import { openIndex, indexSession } from "../src/indexer/sqlite";
import * as store from "../src/indexer/vector-store";
import { cachedSemanticCandidates, activeVectorCacheStatus } from "../src/indexer/active-vector-cache";
import { fixture } from "./support/embedding-fixture";

const scope = { provider_kind: "test", provider_model: "embeddinggemma", dimension: 2 };
function row(message_id = "m", overrides: Partial<store.TextVectorRow> = {}): store.TextVectorRow {
  return { ...scope, session_id: "chatgpt:test", message_id, embedding: [0, 1],
    text: "archived words", title: "T", role: "user", created_at: null, source: "chatgpt", ...overrides };
}
function seed(db: Database, ids = ["m"]) {
  const s = fixture();
  s.messages = ids.map(id => ({ ...s.messages[0], id }));
  indexSession(db, s);
}
const search = (db: Database, limit = 10, model = scope, source?: string) =>
  cachedSemanticCandidates(db, [1, 0], model, source, limit);
function chunks(db: Database, r: store.TextVectorRow, vectors: number[][]) {
  db.transaction(() => store.putTextChunks(db, r, vectors))();
}

test("chunk writes keep chunk zero compatible, cap at 16 and store only full-message digests", () => {
  const db = openIndex(":memory:");
  try {
    seed(db);
    store.putTextVector(db, row("m", { provider_model: "nomic" }));
    const old = db.query("SELECT * FROM message_vectors WHERE provider_model='nomic'").get();
    chunks(db, row(), Array.from({ length: 20 }, (_, i) => i ? [1, 0] : [0, 1]));
    expect(db.query("SELECT * FROM message_vectors WHERE provider_model='nomic'").get()).toEqual(old);
    const first = db.query("SELECT embedding,text,text_hash FROM message_vectors WHERE provider_model=?").get(scope.provider_model) as any;
    expect(Array.from(store.decodeVector(first.embedding, 2))).toEqual([0, 1]);
    expect(first.text).toBe("");
    expect(first.text_hash).toBe(store.textVectorHash("archived words"));
    const extra = db.query("SELECT chunk_index,text_hash,title,embedding FROM message_vector_chunks ORDER BY chunk_index").all() as any[];
    expect(extra.map(r => r.chunk_index)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    expect(extra.every(r => r.text_hash === first.text_hash && r.title === "T")).toBe(true);
    expect(Array.from(store.decodeVector(extra[0].embedding, 2))).toEqual([1, 0]);
    expect((db.query("PRAGMA table_info(message_vector_chunks)").all() as any[]).some(c => c.name === "text")).toBe(false);
    expect(() => chunks(db, row(), [])).toThrow();
    expect(() => chunks(db, row(), [[1, 0], [1]])).toThrow();
    expect(db.query("SELECT * FROM message_vector_chunks").all()).toHaveLength(15);
  } finally { db.close(); }
});

test("a single-vector write clears only its own identity and model dimension", () => {
  const db = openIndex(":memory:");
  try {
    seed(db, ["m", "other"]);
    const rows = [row(), row("other"), row("m", { session_id: "chatgpt:other" }),
      row("m", { provider_model: "other" }), row("m", { provider_kind: "other" }),
      row("m", { dimension: 3, embedding: [0, 1, 0] })];
    for (const r of rows) chunks(db, r, [r.embedding, r.embedding, r.embedding]);
    store.putTextVector(db, row());
    expect(db.query("SELECT * FROM message_vector_chunks").all()).toHaveLength(10);
    chunks(db, row("other"), [[1, 0], [0, 1]]);
    expect(db.query("SELECT * FROM message_vector_chunks WHERE message_id='other'").all()).toHaveLength(1);
  } finally { db.close(); }
});

test("legacy conversion preserves newer binary and orphaned chunk sets", () => {
  const db = openIndex(":memory:");
  try {
    seed(db, ["m", "orphan"]);
    for (const id of ["m", "orphan"]) {
      chunks(db, row(id), [[0, 1], [1, 0]]);
      db.run(`INSERT INTO message_embeddings(session_id,message_id,embedding,text,title,provider_kind,provider_model,dimension)
        VALUES (?,?,?,?,?,?,?,?)`, [row().session_id,id,"[1,0]","older words","old title",scope.provider_kind,scope.provider_model,2]);
    }
    db.run("DELETE FROM message_vectors WHERE message_id='orphan'");
    const before = db.query("SELECT * FROM message_vector_chunks ORDER BY message_id").all();
    expect(store.migrateLegacyVectors(db)).toMatchObject({ scanned: 2, converted: 0, invalid: 0 });
    expect(db.query("SELECT * FROM message_vector_chunks ORDER BY message_id").all()).toEqual(before);
    expect(db.query("SELECT * FROM message_vectors WHERE message_id='orphan'").get()).toBeNull();
  } finally { db.close(); }
});
