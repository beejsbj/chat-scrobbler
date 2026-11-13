import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HashEmbeddingProvider } from "../src/indexer/embedding-providers";
import { indexSession, openIndex } from "../src/indexer/sqlite";
import { pruneEmbeddings } from "../src/indexer/prune-embeddings";
import { embedBackfill } from "../src/indexer/embed-backfill";
import { acquireBackfillLock } from "../src/indexer/backfill-lock";
import { fixture } from "./support/embedding-fixture";

const count = (db: ReturnType<typeof openIndex>, table: string) => (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
async function seeded() {
  const db = openIndex(":memory:");
  const hash = new HashEmbeddingProvider();
  const old = { kind: "ollama" as const, model: "old-model", dimensions: hash.dimensions, embed: (text: string) => hash.embed(text) };
  indexSession(db, fixture(), { embeddingProvider: old });
  const current = new HashEmbeddingProvider();
  indexSession(db, fixture("second words"), { embeddingProvider: current });
  await embedBackfill(db, { provider: old, sleep: async () => {} });
  db.run("INSERT INTO asset_vectors VALUES ('abc','ollama','old-model',2,x'0000803f00000000')");
  db.run("INSERT INTO asset_vectors VALUES ('def','hash',?,2,x'0000803f00000000')", [current.model!]);
  return { db, current };
}

test("with no active provider a dry run counts every stored vector and changes nothing", async () => {
  const { db } = await seeded();
  try {
    const before = { vectors: count(db, "message_vectors"), assets: count(db, "asset_vectors"), pending: count(db, "embedding_pending") };
    expect(before.vectors + before.assets).toBeGreaterThan(0);
    const report = pruneEmbeddings(db, null, { apply: false });
    expect(report).toMatchObject({ applied: false, keep: null });
    expect(report.removed.message_vectors).toBe(before.vectors);
    expect(report.removed.asset_vectors).toBe(2);
    expect(report.removed.embedding_pending).toBe(before.pending);
    expect({ vectors: count(db, "message_vectors"), assets: count(db, "asset_vectors"), pending: count(db, "embedding_pending") }).toEqual(before);
  } finally { db.close(); }
});

test("apply with no active provider removes all vectors and queue state but keeps sessions and text", async () => {
  const { db } = await seeded();
  try {
    pruneEmbeddings(db, null, { apply: true });
    for (const table of ["message_vectors", "message_vector_chunks", "message_embeddings", "asset_vectors", "embedding_pending", "embedding_models"]) expect(count(db, table)).toBe(0);
    expect(count(db, "sessions")).toBeGreaterThan(0);
    expect(count(db, "messages_fts")).toBeGreaterThan(0);
    expect(db.query("SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH 'second'").get()).toEqual({ n: 1 });
    // A second run is a no-op.
    expect(pruneEmbeddings(db, null, { apply: true }).removed).toMatchObject({ message_vectors: 0, asset_vectors: 0, embedding_pending: 0 });
  } finally { db.close(); }
});

test("with an active provider only other providers and models are removed", async () => {
  const { db, current } = await seeded();
  try {
    const keptVectors = (db.query("SELECT COUNT(*) AS n FROM message_vectors WHERE provider_kind=? AND provider_model=?").get(current.kind!, current.model!) as { n: number }).n;
    expect(keptVectors).toBeGreaterThan(0);
    pruneEmbeddings(db, { kind: current.kind!, model: current.model! }, { apply: true });
    expect(count(db, "message_vectors")).toBe(keptVectors);
    expect(db.query("SELECT provider_kind FROM message_vectors GROUP BY provider_kind").all()).toEqual([{ provider_kind: "hash" }]);
    expect(db.query("SELECT sha256 FROM asset_vectors").all()).toEqual([{ sha256: "def" }]);
    expect(count(db, "embedding_pending")).toBe(0); // only the old model had queue rows
  } finally { db.close(); }
});

function cli(root: string, ...args: string[]) {
  const config = join(root, "config.json");
  writeFileSync(config, "{}");
  return Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli/chat-scrobbler.ts"), "prune-embeddings", ...args], {
    env: { ...process.env, CHAT_SCROBBLER_CONFIG: config, CANONICAL_DIR: join(root, "canonical", "sessions"), INDEX_PATH: join(root, "index.db"), CHAT_SCROBBLER_EMBED_PROVIDER: "none" },
  });
}

test("CLI is a dry run unless --apply is given, and refuses while a backfill holds the lease", async () => {
  const root = mkdtempSync(join(tmpdir(), "prune-embeddings-"));
  mkdirSync(join(root, "canonical", "sessions"), { recursive: true });
  try {
    const db = openIndex(join(root, "index.db"));
    indexSession(db, fixture(), { embeddingProvider: new HashEmbeddingProvider() });
    db.close();
    const dry = cli(root, "--json");
    expect(dry.exitCode).toBe(0);
    expect(JSON.parse(dry.stdout.toString())).toMatchObject({ applied: false, keep: null, removed: { message_vectors: 1 } });
    const check = openIndex(join(root, "index.db"));
    expect(count(check, "message_vectors")).toBe(1);
    check.close();
    const lock = acquireBackfillLock(join(root, "index.db"));
    try {
      const busy = cli(root, "--apply");
      expect(busy.exitCode).toBe(1);
      expect(busy.stderr.toString()).toContain("backfill");
    } finally { lock!.release(); }
    const applied = cli(root, "--apply", "--json");
    expect(applied.exitCode).toBe(0);
    expect(JSON.parse(applied.stdout.toString())).toMatchObject({ applied: true });
    const after = openIndex(join(root, "index.db"));
    expect(count(after, "message_vectors")).toBe(0);
    after.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
