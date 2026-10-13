import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reparse } from "../src/core/reparse";
import { storeRawCapture } from "../src/store/raw";
import { parseChatgpt } from "../src/parsers/chatgpt";
import { readSession, writeSession } from "../src/store/sessions";
import { openIndex, searchMessages } from "../src/indexer/sqlite";
import sample from "./fixtures/chatgpt-api-sample.json";

test("reparse rebuilds from the latest raw and leaves canonical sessions without raw untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "reparse-"));
  const opts = { canonicalDir: join(root, "canonical", "sessions"), indexPath: join(root, "index.db") };
  try {
    const old = parseChatgpt(sample)[0];
    old.schema_version = 1;
    writeSession(opts.canonicalDir, old);
    const legacy = { ...old, id: "chatgpt:legacy", source_id: "legacy" };
    const legacyFile = writeSession(opts.canonicalDir, legacy);
    const legacyBytes = readFileSync(legacyFile, "utf8");
    storeRawCapture(join(root, "raw"), sample as any);
    const latest = structuredClone(sample);
    latest.payload.mapping.n1.message.content.parts[0] = "latestneedle";
    latest.fetched_at = "2026-01-01T00:00:00Z"; // arrival order, not fetched_at sort
    const ref = storeRawCapture(join(root, "raw"), latest as any);
    const result = await reparse(opts);
    expect(result).toMatchObject({ changed: 1, no_raw: 1, failed: 0 });
    const rebuilt = readSession(opts.canonicalDir, "chatgpt", "conv-1");
    expect(rebuilt.schema_version).toBe(2);
    expect(rebuilt.raw_ref).toBe(ref);
    expect(rebuilt.messages[0].text).toBe("latestneedle");
    expect(readFileSync(legacyFile, "utf8")).toBe(legacyBytes);
    const db = openIndex(opts.indexPath);
    try { expect(searchMessages(db, "latestneedle")).toHaveLength(1); }
    finally { db.close(); }
    expect(await reparse(opts)).toMatchObject({ changed: 0, unchanged: 1, no_raw: 1 });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);

test("dry-run discovers raw-only sessions without creating canonical, index, or repairing latest metadata", async () => {
  const { existsSync, unlinkSync, readdirSync, statSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "reparse-dry-"));
  const opts = { canonicalDir: join(root, "canonical", "sessions"), indexPath: join(root, "index.db"), dryRun: true };
  try {
    const ref = storeRawCapture(join(root, "raw"), sample as any);
    const marker = join(root, "raw", "chatgpt", "conv-1", "latest.json");
    unlinkSync(marker);
    const rawPath = join(root, "raw", ref);
    const before = statSync(rawPath).mtimeMs;
    expect(await reparse(opts)).toMatchObject({ dry_run: true, changed: 1, failed: 0 });
    expect(existsSync(opts.canonicalDir)).toBe(false);
    expect(existsSync(opts.indexPath)).toBe(false);
    expect(existsSync(marker)).toBe(false);
    expect(statSync(rawPath).mtimeMs).toBe(before);
    expect(readdirSync(join(root, "raw", "chatgpt", "conv-1"))).toHaveLength(1);
    expect(await reparse({ ...opts, dryRun: false })).toMatchObject({ changed: 1 });
    expect(readSession(opts.canonicalDir, "chatgpt", "conv-1").messages).toHaveLength(3);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);

test("reparse skips tombstones and reports malformed raw without replacing existing canonical", async () => {
  const { markSessionDeleted } = await import("../src/store/tombstones");
  const root = mkdtempSync(join(tmpdir(), "reparse-failure-"));
  const opts = { canonicalDir: join(root, "canonical", "sessions"), indexPath: join(root, "index.db") };
  try {
    const file = writeSession(opts.canonicalDir, parseChatgpt(sample)[0]);
    const before = readFileSync(file, "utf8");
    const deleted = { ...sample, source_id: "deleted", payload: { ...sample.payload, conversation_id: "deleted" } };
    storeRawCapture(join(root, "raw"), deleted as any);
    markSessionDeleted(opts.canonicalDir, { source: "chatgpt", source_id: "deleted", deleted_at: "2026-10-13T00:00:00Z" });
    storeRawCapture(join(root, "raw"), { ...sample, payload: { opaque: "payload-secret" } } as any);
    const report = await reparse(opts);
    expect(report).toMatchObject({ failed: 1, deleted: 1, changed: 0 });
    expect(report.items).toContainEqual({ id: "chatgpt:conv-1", status: "failed", reason: "parse_failed" });
    expect(JSON.stringify(report)).not.toContain("payload-secret");
    expect(readFileSync(file, "utf8")).toBe(before);
    storeRawCapture(join(root, "raw"), { ...sample, payload: { ...sample.payload, mapping: {} } } as any);
    expect(await reparse(opts)).toMatchObject({ failed: 1, deleted: 1 });
    expect(readFileSync(file, "utf8")).toBe(before);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);

test("reparse applies source and session filters and reuses unchanged vectors", async () => {
  const { indexSessionWithEmbeddings } = await import("../src/indexer/sqlite");
  const { parseClaude } = await import("../src/parsers/claude");
  const claude = (await import("./fixtures/claude-api-sample.json")).default;
  const root = mkdtempSync(join(tmpdir(), "reparse-vectors-"));
  const opts = { canonicalDir: join(root, "canonical", "sessions"), indexPath: join(root, "index.db") };
  let calls = 0;
  const provider = { kind: "reparse-test", model: "stable", async embed() { calls++; return [1, 0]; } };
  try {
    const existing = parseChatgpt(sample)[0];
    existing.schema_version = 1;
    writeSession(opts.canonicalDir, existing);
    const otherFile = writeSession(opts.canonicalDir, parseClaude(claude)[0]);
    const otherBefore = readFileSync(otherFile, "utf8");
    storeRawCapture(join(root, "raw"), sample as any);
    storeRawCapture(join(root, "raw"), claude as any);
    const db = openIndex(opts.indexPath);
    await indexSessionWithEmbeddings(db, existing, { embeddingProvider: provider });
    const initialCalls = calls;
    const beforeVectors = db.query("SELECT embedding FROM message_embeddings ORDER BY message_id").all();
    try {
      expect(await reparse({ ...opts, source: "chatgpt", embeddingProvider: provider })).toMatchObject({ changed: 1, failed: 0 });
      expect(calls).toBe(initialCalls);
      expect(db.query("SELECT embedding FROM message_embeddings ORDER BY message_id").all()).toEqual(beforeVectors);
      expect(readFileSync(otherFile, "utf8")).toBe(otherBefore);
      const changed = structuredClone(sample);
      changed.payload.mapping.n1.message.content.parts[0] = "changedneedle";
      storeRawCapture(join(root, "raw"), changed as any);
      expect(await reparse({ ...opts, session: "chatgpt:conv-1", embeddingProvider: provider })).toMatchObject({ changed: 1 });
      expect(calls).toBe(initialCalls + 1);
      expect(searchMessages(db, "changedneedle")).toHaveLength(1);
      expect(searchMessages(db, "What is ego")).toHaveLength(0);
      expect(readFileSync(otherFile, "utf8")).toBe(otherBefore);
      await expect(reparse({ ...opts, source: "claude", session: "chatgpt:conv-1" })).rejects.toThrow("disagree");
      await expect(reparse({ ...opts, source: "invalid" })).rejects.toThrow("source");
      await expect(reparse({ ...opts, session: "chatgpt:../../outside" })).rejects.toThrow("session");
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);

test("a corrupt latest raw version fails locally while other sessions still rebuild", async () => {
  const { writeFileSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "reparse-corrupt-"));
  const opts = { canonicalDir: join(root, "canonical", "sessions"), indexPath: join(root, "index.db") };
  try {
    const beforeFile = writeSession(opts.canonicalDir, parseChatgpt(sample)[0]);
    const before = readFileSync(beforeFile, "utf8");
    const ref = storeRawCapture(join(root, "raw"), sample as any);
    writeFileSync(join(root, "raw", ref), "invalid gzip with payload-secret");
    const healthy = { ...sample, source_id: "healthy", payload: { ...sample.payload, conversation_id: "healthy" } };
    storeRawCapture(join(root, "raw"), healthy as any);
    const report = await reparse(opts);
    expect(report).toMatchObject({ failed: 1, changed: 1 });
    expect(report.items).toContainEqual({ id: "chatgpt:conv-1", status: "failed", reason: "raw_read_failed" });
    expect(readFileSync(beforeFile, "utf8")).toBe(before);
    expect(readSession(opts.canonicalDir, "chatgpt", "healthy").messages).toHaveLength(3);
    expect(JSON.stringify(report)).not.toContain("payload-secret");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);

test("embedding failure reports degraded vectors while rebuilt canonical and FTS remain usable", async () => {
  const { spyOn } = await import("bun:test");
  const logs = spyOn(console, "error").mockImplementation(() => {});
  const root = mkdtempSync(join(tmpdir(), "reparse-embed-failure-"));
  const opts = { canonicalDir: join(root, "canonical", "sessions"), indexPath: join(root, "index.db") };
  try {
    storeRawCapture(join(root, "raw"), sample as any);
    const report = await reparse({ ...opts, embeddingProvider: { async embed() { throw new Error("provider-secret"); } } });
    expect(report).toMatchObject({ changed: 1, failed: 0, embedding_failures: 1 });
    expect(readSession(opts.canonicalDir, "chatgpt", "conv-1").schema_version).toBe(2);
    const db = openIndex(opts.indexPath);
    try { expect(searchMessages(db, "What is ego")).toHaveLength(1); }
    finally { db.close(); }
    expect(JSON.stringify(logs.mock.calls)).not.toContain("provider-secret");
  } finally { logs.mockRestore(); rmSync(root, { recursive: true, force: true }); }
}, 30000);
