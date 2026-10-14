import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { openIndex, indexSession } from "../src/indexer/sqlite";
import * as store from "../src/indexer/vector-store";
import { cachedSemanticCandidates, activeVectorCacheStatus, warmActiveVectorCache } from "../src/indexer/active-vector-cache";
import { createSearchRevision, changedSearchVectors, changedSearchSessions, searchRevision } from "../src/indexer/search-revision";
import { fixture } from "./support/embedding-fixture";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

test("search ranks by maximum chunk cosine and returns unique messages before top-N", () => {
  const db = openIndex(":memory:");
  try {
    seed(db, ["m", "second", "third"]);
    // The pooled direction is [3,4] (cosine 0.6), below second's 0.8.
    chunks(db, row(), [[0, 1], [1, 0], [1, 0], [1, 0], [0, 1], [0, 1], [0, 1]]);
    chunks(db, row("second"), [[4, 3]]);
    chunks(db, row("third"), [[3, 4], [-1, 0]]);
    const hits = search(db, 2);
    expect(hits.map(h => h.message_id)).toEqual(["m", "second"]);
    expect(hits[0].similarity).toBeCloseTo(1, 6);
    expect(hits[1].similarity).toBeCloseTo(0.8, 6);
    expect(search(db, 1).map(h => h.message_id)).toEqual(["m"]);
    expect(search(db, 2, scope, "claude")).toEqual([]);
    expect(activeVectorCacheStatus(db)?.rows).toBe(3);
  } finally { db.close(); }
});

test("extra-only updates and deletes refresh all slots for just their message", () => {
  const db = openIndex(":memory:");
  try {
    seed(db, ["m", "second"]);
    chunks(db, row(), [[0, 1], [1, 0], [4, 3]]);
    chunks(db, row("second"), [[3, 4]]);
    expect(search(db).map(h => h.message_id)).toEqual(["m", "second"]);
    const before = activeVectorCacheStatus(db)!;
    db.run("UPDATE message_vector_chunks SET embedding=? WHERE chunk_index=1", [store.encodeVector([0, 1])]);
    expect(search(db)[0].similarity).toBeCloseTo(0.8, 6);
    expect(activeVectorCacheStatus(db)).toMatchObject({ builds: before.builds, message_refreshes: before.message_refreshes + 1 });
    db.run("DELETE FROM message_vector_chunks WHERE message_id='m'");
    expect(search(db).map(h => h.message_id)).toEqual(["second"]);
    expect(activeVectorCacheStatus(db)).toMatchObject({ builds: before.builds, message_refreshes: before.message_refreshes + 2 });
    chunks(db, row(), [[1, 0], [0, 1]]);
    expect(search(db)[0].message_id).toBe("m");
    store.putTextVector(db, row());
    expect(search(db).map(h => h.message_id)).toEqual(["second"]);
  } finally { db.close(); }
});

test("other-model chunk mutations leave the active nomic matrix and results identical", () => {
  const db = openIndex(":memory:");
  const nomic = { ...scope, provider_model: "nomic" };
  try {
    seed(db, ["m", "second"]);
    store.putTextVector(db, row("m", { ...nomic, embedding: [4, 3] }));
    store.putTextVector(db, row("second", { ...nomic, embedding: [3, 4] }));
    chunks(db, row(), [[0, 1], [1, 0]]);
    const original = search(db, 2, nomic), before = activeVectorCacheStatus(db);
    db.run("UPDATE message_vector_chunks SET embedding=?", [store.encodeVector([0, 1])]);
    expect(search(db, 2, nomic)).toEqual(original);
    expect(activeVectorCacheStatus(db)).toEqual(before);
    db.run("DELETE FROM message_vector_chunks");
    expect(search(db, 2, nomic)).toEqual(original);
    expect(activeVectorCacheStatus(db)).toEqual(before);
  } finally { db.close(); }
});

test("each chunk requires the current full-message hash and title after partial changes", () => {
  const db = openIndex(":memory:");
  try {
    seed(db, ["m", "second"]);
    chunks(db, row(), [[1, 0], [1, 0]]);
    chunks(db, row("second"), [[3, 4]]);
    expect(search(db)).toHaveLength(2);
    const edited = fixture("edited words"); edited.title = "new title";
    edited.messages.push({ ...fixture().messages[0], id: "second" });
    indexSession(db, edited);
    expect(search(db)).toEqual([]);
    // Hash alone cannot revive a chunk embedded with a different title.
    db.run("UPDATE message_vector_chunks SET text_hash=? WHERE message_id='m'", [store.textVectorHash("edited words")]);
    expect(search(db)).toEqual([]);
    db.run("UPDATE message_vector_chunks SET title='new title' WHERE message_id='m'");
    expect(search(db).map(h => [h.message_id, h.text, h.title])).toEqual([["m", "edited words", "new title"]]);
    // Repairing chunk zero must not make an older extra's stronger direction fresh.
    db.run("UPDATE message_vector_chunks SET text_hash=?", [store.textVectorHash("older words")]);
    db.run("UPDATE message_vectors SET embedding=?,text_hash=?,title='new title' WHERE message_id='m'",
      [store.encodeVector([3, 4]), store.textVectorHash("edited words")]);
    expect(search(db)[0].similarity).toBeCloseTo(0.6, 6);
  } finally { db.close(); }
});

test("moving an extra's identity and model marks both scopes without literal session dirties", () => {
  const db = openIndex(":memory:");
  try {
    seed(db, ["m", "second"]);
    chunks(db, row(), [[0, 1], [1, 0]]);
    const revision = searchRevision(db);
    db.run("UPDATE message_vector_chunks SET message_id='second',provider_model='other'");
    expect(changedSearchSessions(db, revision)).toEqual(new Set());
    expect(changedSearchVectors(db, revision, scope)).toEqual([{ session_id: row().session_id, message_id: "m" }]);
    expect(changedSearchVectors(db, revision, { ...scope, provider_model: "other" })).toEqual([{ session_id: row().session_id, message_id: "second" }]);
    expect(changedSearchVectors(db, revision, { ...scope, provider_model: "nomic" })).toEqual([]);
    expect(search(db)).toEqual([]);
    expect(search(db, 10, { ...scope, provider_model: "other" }).map(h => h.message_id)).toEqual(["second"]);
  } finally { db.close(); }
});

test("queue and model state writes advance revision without dirtying any search scope", () => {
  // Minimal tables exercise revision wiring without assuming queue/state schemas.
  const db = new Database(":memory:");
  try {
    db.run("CREATE TABLE sessions(id TEXT)");
    for (const table of ["message_vectors", "message_vector_chunks", "message_embeddings"])
      db.run(`CREATE TABLE ${table}(session_id TEXT,message_id TEXT,provider_kind TEXT,provider_model TEXT,dimension INTEGER)`);
    for (const table of ["asset_vectors", "locks", "embedding_pending", "embedding_models"])
      db.run(`CREATE TABLE ${table}(id INTEGER)`);
    createSearchRevision(db);
    for (const table of ["embedding_pending", "embedding_models"]) {
      for (const sql of [`INSERT INTO ${table} VALUES (1)`, `UPDATE ${table} SET id=2`, `DELETE FROM ${table}`]) {
        const revision = searchRevision(db);
        db.run(sql);
        expect(searchRevision(db)).toBe(revision + 1);
        expect(changedSearchSessions(db, revision, scope)).toEqual(new Set());
        expect(changedSearchVectors(db, revision, scope)).toEqual([]);
      }
    }
  } finally { db.close(); }
});

test("chunk refreshes rolled back after searching cannot leave uncommitted slots cached", () => {
  const db = openIndex(":memory:");
  try {
    seed(db);
    chunks(db, row(), [[0, 1], [1, 0]]);
    expect(search(db)).toHaveLength(1);
    expect(() => db.transaction(() => {
      chunks(db, row(), [[0, 1], [0, 1]]);
      expect(search(db)).toEqual([]);
      throw new Error("rollback");
    })()).toThrow("rollback");
    expect(search(db)[0].similarity).toBeCloseTo(1, 6);
  } finally { db.close(); }
});

test("WAL readers keep one chunk snapshot during concurrent replacement then refresh", () => {
  const root = mkdtempSync(join(tmpdir(), "chunk-vector-wal-")), path = join(root, "synthetic.db");
  const writer = openIndex(path), reader = openIndex(path);
  try {
    seed(writer);
    chunks(writer, row(), [[0, 1], [1, 0]]);
    expect(search(reader)).toHaveLength(1);
    const before = activeVectorCacheStatus(reader)!;
    reader.transaction(() => {
      expect(search(reader)).toHaveLength(1);
      chunks(writer, row(), [[0, 1], [0, 1]]);
      expect(search(reader)).toHaveLength(1);
    })();
    expect(search(reader)).toEqual([]);
    expect(activeVectorCacheStatus(reader)).toMatchObject({ builds: before.builds, message_refreshes: before.message_refreshes + 1 });
  } finally { reader.close(); writer.close(); rmSync(root, { recursive: true, force: true }); }
});

test("cooperative warmup includes chunks and refreshes extra-only edits made during yields", async () => {
  const db = openIndex(":memory:");
  try {
    seed(db);
    chunks(db, row(), [[0, 1], [1, 0]]);
    search(db); // Prepare the message lookup as the warmup coordinator does.
    await warmActiveVectorCache(db, scope, { batchSize: 1, yield: async () => {} }, () => {});
    expect(search(db)).toHaveLength(1);
    let yields = 0;
    await warmActiveVectorCache(db, scope, { batchSize: 1, yield: async () => {
      if (++yields === 3) db.run("UPDATE message_vector_chunks SET embedding=?", [store.encodeVector([0, 1])]);
    } }, () => {});
    expect(yields).toBeGreaterThan(3);
    expect(search(db)).toEqual([]);
  } finally { db.close(); }
});
