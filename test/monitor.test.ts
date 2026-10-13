import { Database } from "bun:sqlite";
import { recordParseOutcome } from "../src/monitor/parse-state";
import { monitorReport } from "../src/monitor/report";
import { incrementMonitorCounter, recordCaptureReceipt, readMonitorState } from "../src/monitor/state";
import { expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleIngestRequest } from "../packages/ingest/src/server";
import { getParser } from "../src/parsers/registry";
import { deleteSessionArchive } from "../src/store/delete";
import { storeCanonicalAsset } from "../src/store/assets";
import { readSession, writeSession } from "../src/store/sessions";
import { storeRawCapture } from "../src/store/raw";
import { HashEmbeddingProvider } from "../src/indexer/embedding-providers";
import { indexSession, openIndex } from "../src/indexer/sqlite";
import chatgpt from "./fixtures/chatgpt-api-sample.json";
import claude from "./fixtures/claude-api-sample.json";
import gemini from "./fixtures/gemini-api-sample.json";
import type { RawCapture } from "../packages/shared/src";

function setup(parsedAt = Date.now()) {
  const root = mkdtempSync(join(import.meta.dir, ".monitor-"));
  const opts = { canonicalDir: join(root, "canonical", "sessions"), indexPath: join(root, "index.db"), ingestToken: "report-secret", embeddingProvider: new HashEmbeddingProvider() };
  const db = openIndex(opts.indexPath);
  for (const sample of [chatgpt, claude, gemini]) {
    const capture = { ...structuredClone(sample), fetched_at: new Date().toISOString() } as RawCapture;
    storeRawCapture(join(root, "raw"), capture);
    recordCaptureReceipt(`${opts.indexPath}.monitor.sqlite`, capture.source);
    recordParseOutcome(`${opts.indexPath}.monitor.sqlite`, capture.source, capture.source_id, true, parsedAt);
    for (const session of getParser(capture.source, "api")(capture)) {
      for (const message of session.messages) for (const block of message.blocks) {
        if ("local_path" in block) Object.assign(block, storeCanonicalAsset({ canonicalDir: opts.canonicalDir, source: session.source, sourceId: session.source_id, pointer: block.pointer, bytes: new Uint8Array([1, 2, 3]) }));
      }
      writeSession(opts.canonicalDir, session);
      indexSession(db, session, { embeddingProvider: opts.embeddingProvider });
    }
  }
  db.close();
  return { root, opts };
}
const request = () => new Request("http://local/status/report", { headers: { authorization: "Bearer report-secret" } });

test("status report is token gated and healthy with recent captures of old conversations", async () => {
  const { root, opts } = setup();
  try {
    expect((await handleIngestRequest(new Request("http://local/status/report"), opts)).status).toBe(401);
    expect((await handleIngestRequest(request(), { ...opts, ingestToken: null })).status).toBe(401);
    for (const source of ["chatgpt", "claude", "gemini"] as const) recordCaptureReceipt(`${opts.indexPath}.monitor.sqlite`, source);
    const response = await handleIngestRequest(request(), opts);
    expect(response.status).toBe(200);
    const report = await response.json();
    expect(report).toMatchObject({ ok: true, failures: [], providers: { chatgpt: { stale: false }, claude: { stale: false }, gemini: { stale: false } } });
    const output = JSON.stringify(report);
    for (const secret of ["report-secret", "Ego and Identity", "Healing", "https://", "file-service://"]) expect(output).not.toContain(secret);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const entry = join(import.meta.dir, "../src/cli/chat-scrobbler.ts");
function cli(opts: ReturnType<typeof setup>["opts"], ...args: string[]) {
  return Bun.spawnSync([process.execPath, entry, "monitor", ...args], { env: { ...process.env, CANONICAL_DIR: opts.canonicalDir, INDEX_PATH: opts.indexPath, CHAT_SCROBBLER_CONFIG: join(opts.canonicalDir, "absent.json"), CHAT_SCROBBLER_EMBED_PROVIDER: "hash" } });
}

test("offline monitor is quiet when healthy; unknown acknowledgement persists and new types alert safely", () => {
  const { root, opts } = setup();
  try {
    const healthy = cli(opts);
    expect(healthy.exitCode).toBe(0);
    expect(healthy.stdout.toString()).toBe("");
    expect(healthy.stderr.toString()).toBe("");
    const capture = { ...structuredClone(chatgpt), fetched_at: new Date().toISOString() } as any;
    capture.payload.mapping.n3.message.content.parts = [{ content_type: "https://secret?token=do-not-print", text: "chat-secret" }];
    const session = getParser("chatgpt", "api")(capture)[0];
    writeSession(opts.canonicalDir, session);
    const db = openIndex(opts.indexPath);
    indexSession(db, session, { embeddingProvider: opts.embeddingProvider });
    db.close();
    const failed = cli(opts);
    expect(failed.exitCode).toBe(0);
    expect(failed.stdout.toString()).toMatch(/^FAILED unknown.chatgpt type_id=[a-f0-9]{16} count=1\n$/);
    expect(failed.stdout.toString() + failed.stderr.toString()).not.toContain("secret");
    expect(cli(opts, "--ack").stdout.toString()).toBe("");
    expect(cli(opts).stdout.toString()).toBe("");
    capture.payload.mapping.n3.message.content.parts.push({ content_type: "second_future_type" });
    writeSession(opts.canonicalDir, getParser("chatgpt", "api")(capture)[0]);
    expect(cli(opts).stdout.toString()).toMatch(/^FAILED unknown.chatgpt type_id=[a-f0-9]{16} count=1\n$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("asset counters and capture receipt freshness survive a fresh CLI process", async () => {
  const { root, opts } = setup();
  try {
    const response = await handleIngestRequest(new Request("http://local/status", { method: "POST", body: JSON.stringify({ source: "claude", conversations: [], asset_failures: [{ source_id: "cl-1", reason: "asset_upload_failed", pointer: "https://secret?token=never-print" }] }) }), { ...opts, ingestToken: null });
    expect(response.status).toBe(200);
    const output = cli(opts);
    expect(output.exitCode).toBe(0);
    expect(output.stdout.toString()).toBe("FAILED assets recent_upload_failures=1\n");
    expect(output.stderr.toString()).toBe("");
    const report = await monitorReport(opts);
    expect(report.assets).toMatchObject({ upload_failures: 1, recent_upload_failures: 1 });
    const capture = { ...structuredClone(claude), fetched_at: "2020-01-01T00:00:00Z" };
    const ingest = await handleIngestRequest(new Request("http://local/captures", { method: "POST", body: JSON.stringify(capture) }), { ...opts, ingestToken: null });
    expect(ingest.status).toBe(200);
    // Receipt of a fresh duplicate poll stays fresh even if provider capture dates are old.
    const fresh = cli(opts);
    expect(fresh.stdout.toString()).not.toContain("freshness.claude");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("embedding failures remain counted after changing provider instances without retaining error details", async () => {
  const { root, opts } = setup();
  try {
    const broken = { kind: "hash", model: "broken-model", async embed() { throw new Error("https://secret?token=chat-secret"); } };
    const response = await handleIngestRequest(new Request("http://local/captures", { method: "POST", body: JSON.stringify({ ...claude, fetched_at: new Date().toISOString() }) }), { ...opts, ingestToken: null, embeddingProvider: broken });
    expect(response.status).toBe(200);
    const report = await (await handleIngestRequest(request(), { ...opts, embeddingProvider: new HashEmbeddingProvider() })).json();
    expect(report.counters.embedding_ingest_failures).toBe(1);
    expect(report.counters.embedding_ingest_failures).toBe(1);
    expect(JSON.stringify(report)).not.toContain("secret");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("recent coverage excludes old-model and stale-text vectors; missing assets are counted", async () => {
  const { root, opts } = setup();
  try {
    const session = getParser("chatgpt", "api")(chatgpt as RawCapture)[0];
    for (const message of session.messages.slice(0, 2)) {
      message.created_at = new Date().toISOString();
      message.text = "Changed fixture text";
    }
    writeSession(opts.canonicalDir, session);
    const db = openIndex(opts.indexPath);
    indexSession(db, session);
    db.close();
    const report = await monitorReport(opts);
    expect(report.embeddings.coverage).toMatchObject({ recent_with_vectors: 0, recent_without_vectors: 2, recent_coverage: 0 });
    expect(report.failures).toContain("FAILED embeddings recent_with_vectors=0 recent_without_vectors=2 threshold=0.95");
    expect(report.failures).toContain("FAILED assets missing_recent_blocks=1");
    const changedModel = Object.assign(new HashEmbeddingProvider(), { model: "replacement-model" });
    const next = await monitorReport({ ...opts, embeddingProvider: changedModel });
    expect(next.embeddings.coverage).toMatchObject({ with_vectors: 0, without_vectors: 9 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("orphan parse failures persist in raw while failures with canonical and tombstones are excluded", async () => {
  const { root, opts } = setup();
  try {
    storeRawCapture(join(root, "raw"), { ...claude, source_id: "failed-contract", payload: "chat-secret", fetched_at: new Date().toISOString() } as RawCapture);
    storeRawCapture(join(root, "raw"), { ...chatgpt, payload: "chat-secret", fetched_at: new Date().toISOString() } as RawCapture);
    const first = cli(opts);
    expect(first.exitCode).toBe(0);
    expect(first.stdout.toString()).toBe("FAILED parse failed_versions_without_canonical=1\n");
    expect(cli(opts).stdout.toString()).toBe(first.stdout.toString());
    expect(first.stderr.toString()).toBe("");
    deleteSessionArchive(opts.canonicalDir, "claude", "failed-contract");
    // Even a stray archive after deletion must not resurrect an alert.
    storeRawCapture(join(root, "raw"), { ...claude, source_id: "failed-contract", payload: "chat-secret", fetched_at: new Date().toISOString() } as RawCapture);
    expect(cli(opts).stdout.toString()).toBe("");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("freshness defaults detect stale and absent providers and support independent overrides", async () => {
  const root = mkdtempSync(join(import.meta.dir, ".monitor-"));
  const opts = { canonicalDir: join(root, "canonical", "sessions"), indexPath: join(root, "index.db"), ingestToken: "report-secret", embeddingProvider: new HashEmbeddingProvider() };
  try {
    const db = openIndex(opts.indexPath);
    db.close();
    const capture = { ...chatgpt, fetched_at: new Date(Date.now() - 8 * 86_400_000).toISOString() } as RawCapture;
    storeRawCapture(join(root, "raw"), capture);
    // A recorded successful parse uses the capture date; legacy canonical is older.
    recordParseOutcome(`${opts.indexPath}.monitor.sqlite`, "chatgpt", capture.source_id, true, Date.parse(capture.fetched_at));
    writeSession(opts.canonicalDir, getParser("chatgpt", "api")(capture)[0]);
    const report = await monitorReport(opts);
    expect(report.failures).toContain("FAILED freshness.chatgpt stale threshold_days=7");
    expect(report.failures).toContain("FAILED freshness.claude no_captures");
    const tuned = await monitorReport({ ...opts, monitorStaleDays: { chatgpt: 14, claude: null, gemini: null } });
    expect(tuned.failures.some((line: string) => line.includes("freshness"))).toBe(false);
    const receipt = await handleIngestRequest(new Request("http://local/captures", { method: "POST", body: JSON.stringify(capture) }), { ...opts, ingestToken: null });
    expect(receipt.status).toBe(200);
    expect(cli(opts).stdout.toString()).not.toContain("freshness.chatgpt");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("HTTP snapshots cache small state reads for 60 seconds", async () => {
  const { root, opts } = setup();
  const originalNow = Date.now;
  const path = `${opts.indexPath}.monitor.sqlite`;
  try {
    for (const source of ["chatgpt", "claude", "gemini"] as const) recordCaptureReceipt(path, source);
    const responses = await Promise.all([handleIngestRequest(request(), opts), handleIngestRequest(request(), opts)]);
    const first = await responses[0].json();
    expect(first).toEqual(await responses[1].json());
    incrementMonitorCounter(path, "asset_failures");
    Date.now = () => originalNow() + 59_000;
    expect(await (await handleIngestRequest(request(), opts)).json()).toEqual(first);
    Date.now = () => originalNow() + 61_000;
    const expired = await (await handleIngestRequest(request(), opts)).json();
    expect(expired.assets.recent_upload_failures).toBe(1);
  } finally { Date.now = originalNow; rmSync(root, { recursive: true, force: true }); }
});

test("offline monitor reports a missing index consistently without creating a replacement", () => {
  const { root, opts } = setup();
  try {
    rmSync(opts.indexPath);
    const first = cli(opts);
    expect(first.exitCode).toBe(0);
    expect(first.stdout.toString()).toBe("FAILED store.index index_missing\n");
    expect(cli(opts).stdout.toString()).toBe(first.stdout.toString());
    expect(existsSync(opts.indexPath)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("semantic leg alerts with no usable vectors even when messages are older than the coverage window", async () => {
  const { root, opts } = setup();
  try {
    const provider = Object.assign(new HashEmbeddingProvider(), { model: "not-indexed-yet" });
    const report = await monitorReport({ ...opts, embeddingProvider: provider });
    expect(report.embeddings.coverage?.recent_without_vectors).toBe(0);
    expect(report.failures).toContain("FAILED semantic no_usable_vectors");
    expect(report.embeddings.semantic).toBe("unavailable");
    expect(report.health.semantic).toBe("available");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("store failures remain categorical and a configured state path is shared by ingest and CLI", async () => {
  const { root, opts } = setup();
  const statePath = join(root, "telemetry", "monitor.sqlite");
  try {
    for (const capture of [chatgpt, claude, gemini] as RawCapture[]) {
      recordCaptureReceipt(statePath, capture.source);
      recordParseOutcome(statePath, capture.source, capture.source_id, true);
    }
    const response = await handleIngestRequest(new Request("http://local/status", { method: "POST", body: JSON.stringify({ source: "chatgpt", conversations: [], asset_failures: [{ source_id: "conv-1", reason: "asset_upload_failed" }] }) }), { ...opts, ingestToken: null, monitorStatePath: statePath });
    expect(response.status).toBe(200);
    const processResult = Bun.spawnSync([process.execPath, entry, "monitor"], { env: { ...process.env, CANONICAL_DIR: opts.canonicalDir, INDEX_PATH: opts.indexPath, CHAT_SCROBBLER_EMBED_PROVIDER: "hash", CHAT_SCROBBLER_CONFIG: join(root, "absent.json"), CHAT_SCROBBLER_MONITOR_STATE_PATH: statePath } });
    expect(processResult.stdout.toString()).toBe("FAILED assets recent_upload_failures=1\n");
    rmSync(join(root, "raw"), { recursive: true });
    writeFileSync(join(root, "raw"), "chat-secret");
    const report = await monitorReport({ ...opts, monitorStatePath: statePath });
    expect(report.failures).toContain("FAILED store.raw store_access_failed");
    expect(JSON.stringify(report)).not.toContain("chat-secret");
    const brokenIndex = join(root, "broken.db");
    writeFileSync(brokenIndex, "chat-secret");
    const corrupt = cli({ ...opts, indexPath: brokenIndex });
    expect(corrupt.exitCode).toBe(0);
    expect(corrupt.stdout.toString()).toContain("FAILED index unreadable_or_incompatible");
    expect(corrupt.stdout.toString() + corrupt.stderr.toString()).not.toContain("chat-secret");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("offline monitor reports unavailable configured embeddings and handles invalid arguments without leaking them", () => {
  const { root, opts } = setup();
  try {
    const result = Bun.spawnSync([process.execPath, entry, "monitor"], { env: { ...process.env, CANONICAL_DIR: opts.canonicalDir, INDEX_PATH: opts.indexPath, CHAT_SCROBBLER_CONFIG: join(root, "absent.json"), CHAT_SCROBBLER_EMBED_PROVIDER: "gemini", GEMINI_API_KEY: "", GOOGLE_API_KEY: "" } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("FAILED semantic unavailable\n");
    expect(result.stderr.toString()).toBe("");
    const invalid = cli(opts, "--chat-secret");
    expect(invalid.exitCode).toBe(0);
    expect(invalid.stdout.toString()).toBe("FAILED monitor invalid_arguments\n");
    expect(invalid.stderr.toString()).toBe("");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("recent media blocks missing a local_path field still alert", async () => {
  const { root, opts } = setup();
  try {
    const session = getParser("chatgpt", "api")(chatgpt as RawCapture)[0];
    session.updated_at = new Date().toISOString();
    for (const message of session.messages) for (const block of message.blocks) {
      if ("local_path" in block) delete (block as any).local_path;
    }
    writeSession(opts.canonicalDir, session);
    const report = await monitorReport(opts);
    expect(report.assets.missing_recent_blocks).toBe(1);
    expect(report.failures).toContain("FAILED assets missing_recent_blocks=1");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a broken monitor database cannot stop parsing, canonical writes or indexing", async () => {
  const { root, opts } = setup();
  const statePath = join(root, "broken-state.sqlite");
  try {
    writeFileSync(statePath, "not a database");
    const capture = structuredClone(claude);
    capture.payload.name = "Updated fixture";
    const response = await handleIngestRequest(new Request("http://local/captures", { method: "POST", body: JSON.stringify(capture) }), { ...opts, monitorStatePath: statePath, ingestToken: null });
    expect(response.status).toBe(200);
    expect((await response.json()).spine[0].indexed).toBe(true);
    expect(readSession(opts.canonicalDir, "claude", "cl-1").title).toBe("Updated fixture");
    const report = await monitorReport({ ...opts, monitorStatePath: statePath });
    expect(report.failures.some((line: string) => line.startsWith("FAILED state "))).toBe(true);
    expect(report.failures.some((line: string) => line.includes("freshness"))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a locked state writer does not stall ingest and its failure is visible offline", async () => {
  const { root, opts } = setup();
  const path = `${opts.indexPath}.monitor.sqlite`;
  recordCaptureReceipt(path, "chatgpt");
  const lock = new Database(path);
  try {
    lock.run("BEGIN IMMEDIATE");
    const start = performance.now();
    const response = await handleIngestRequest(new Request("http://local/captures", { method: "POST", body: JSON.stringify(claude) }), { ...opts, ingestToken: null });
    expect(response.status).toBe(200);
    expect(performance.now() - start).toBeLessThan(1000);
    // Empty polls perform no telemetry write and must not clear a failed-write marker.
    const emptyStatus = await handleIngestRequest(new Request("http://local/status", { method: "POST", body: JSON.stringify({ source: "claude", conversations: [], asset_failures: [] }) }), { ...opts, ingestToken: null });
    expect(emptyStatus.status).toBe(200);
    const emptyCaptures = await handleIngestRequest(new Request("http://local/captures", { method: "POST", body: "[]" }), { ...opts, ingestToken: null });
    expect(emptyCaptures.status).toBe(200);
    expect(cli(opts).stdout.toString()).toContain("FAILED state write_failed");
  } finally { lock.run("ROLLBACK"); lock.close(); rmSync(root, { recursive: true, force: true }); }
}, 15000);

test("monitor refuses to create state under a different effective owner", async () => {
  const { root, opts } = setup();
  opts.indexPath = join(root, "fresh-index.db");
  const uid = process.getuid!();
  const getuid = spyOn(process, "getuid").mockReturnValue(uid + 1);
  try {
    const report = await monitorReport(opts, true);
    expect(report.failures).toContain("FAILED state owner_mismatch");
    expect(existsSync(`${opts.indexPath}.monitor.sqlite`)).toBe(false);
  } finally { getuid.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

test("asset telemetry failure does not break conversation status responses", async () => {
  const { root, opts } = setup();
  const path = join(root, "blocked.sqlite");
  try {
    writeFileSync(path, "not a database");
    const response = await handleIngestRequest(new Request("http://local/status", { method: "POST", body: JSON.stringify({ source: "claude", conversations: [{ id: "cl-1" }], asset_failures: [{ source_id: "cl-1", reason: "asset_upload_failed" }] }) }), { ...opts, ingestToken: null, monitorStatePath: path });
    expect(response.status).toBe(200);
    expect((await response.json()).asset_failures).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ordinary monitoring creates no state and remains readable during an index rebuild", async () => {
  const { root, opts } = setup();
  const statePath = join(root, "absent-state.sqlite");
  const db = openIndex(opts.indexPath);
  try {
    db.run("BEGIN IMMEDIATE");
    const start = performance.now();
    const report = await monitorReport({ ...opts, monitorStatePath: statePath, monitorStaleDays: { chatgpt: null, claude: null, gemini: null } });
    expect(performance.now() - start).toBeLessThan(1000);
    expect(report.failures).toEqual([]);
    expect(existsSync(statePath)).toBe(false);
    expect(readdirSync(opts.canonicalDir).some(file => file.startsWith(".health-"))).toBe(false);
  } finally { db.run("ROLLBACK"); db.close(); rmSync(root, { recursive: true, force: true }); }
}, 15000);

test("monitor does not create missing stores while checking their permissions", async () => {
  const root = mkdtempSync(join(import.meta.dir, ".monitor-"));
  try {
    await monitorReport({ canonicalDir: join(root, "canonical", "sessions"), indexPath: join(root, "index", "missing.db"), embeddingProvider: new HashEmbeddingProvider() });
    expect(readdirSync(root)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("HTTP snapshots use persisted receipts without archive scans or embedding calls", async () => {
  const { root, opts } = setup();
  const path = `${opts.indexPath}.monitor.sqlite`;
  for (const source of ["chatgpt", "claude", "gemini"] as const) recordCaptureReceipt(path, source);
  let probes = 0;
  const provider = { kind: "hash", embed() { probes++; throw new Error("must not probe"); } };
  try {
    rmSync(join(root, "raw"), { recursive: true });
    writeFileSync(join(root, "raw"), "blocked");
    writeFileSync(join(opts.canonicalDir, "claude", "cl-1.json"), "invalid JSON");
    const report = await (await handleIngestRequest(request(), { ...opts, embeddingProvider: provider })).json();
    expect(report.scope).toBe("live");
    expect(probes).toBe(0);
    expect(report.failures).toEqual([]);
    expect(report.deferred_checks).toContain("embedding_coverage");
    expect(report.deferred_checks).toContain("canonical");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("parse failures on an existing conversation survive restart and stale successful captures alert", async () => {
  const { root, opts } = setup(Date.now() - 8 * 86_400_000);
  try {
    recordParseOutcome(`${opts.indexPath}.monitor.sqlite`, "chatgpt", "conv-1", true, Date.now() - 8 * 86_400_000);
    const response = await handleIngestRequest(new Request("http://local/captures", { method: "POST", body: JSON.stringify({ ...chatgpt, payload: null, fetched_at: new Date().toISOString() }) }), { ...opts, ingestToken: null });
    expect(response.status).toBe(400);
    const report = await (await handleIngestRequest(request(), opts)).json();
    expect(report.counters.parse_chatgpt_failures).toBe(1);
    expect(report.providers.chatgpt.stale).toBe(false);
    expect(report.providers.chatgpt.parsed_stale).toBe(true);
    expect(report.failures).toContain("FAILED freshness.parsed.chatgpt stale threshold_days=7");
    expect(report.failures).toContain("FAILED parse.chatgpt recent_failed_sessions=1");
    expect(report.parse.chatgpt.session_ids[0]).toMatch(/^chatgpt:[a-f0-9]{16}$/);
    expect(cli(opts).stdout.toString()).toContain("FAILED parse.chatgpt recent_failed_sessions=1");
    expect(readSession(opts.canonicalDir, "chatgpt", "conv-1").messages.length).toBeGreaterThan(0);
    expect(JSON.stringify(report)).not.toContain("Ego and Identity");
    const recovered = await handleIngestRequest(new Request("http://local/captures", { method: "POST", body: JSON.stringify(chatgpt) }), { ...opts, ingestToken: null });
    expect(recovered.status).toBe(200);
    const fresh = await monitorReport(opts);
    expect(fresh.parse.chatgpt?.total_failures).toBe(1);
    expect(fresh.failures.some(line => line.startsWith("FAILED parse.chatgpt") || line.startsWith("FAILED freshness.parsed.chatgpt"))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a canonical write failure does not count as a parser failure", async () => {
  const { root, opts } = setup();
  try {
    const capture = structuredClone(chatgpt);
    capture.payload.conversation_id = "invalid/path";
    const response = await handleIngestRequest(new Request("http://local/captures", { method: "POST", body: JSON.stringify(capture) }), { ...opts, ingestToken: null });
    expect(response.status).toBe(400);
    const report = await monitorReport(opts);
    expect(report.parse.chatgpt?.total_failures).toBe(0);
    expect(report.parse.chatgpt?.recent_failed_sessions).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rewriting old canonical sessions does not make missing attachments recent", async () => {
  const { root, opts } = setup();
  try {
    const session = getParser("chatgpt", "api")(chatgpt as RawCapture)[0];
    writeSession(opts.canonicalDir, session);
    writeSession(opts.canonicalDir, session);
    expect((await monitorReport(opts)).assets.missing_recent_blocks).toBe(0);
    session.messages[0].created_at = new Date().toISOString();
    writeSession(opts.canonicalDir, session);
    expect((await monitorReport(opts)).assets.missing_recent_blocks).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an embedder responding after two seconds is slow rather than unavailable", async () => {
  const { root, opts } = setup();
  const provider = { kind: "hash", model: "hash-v1", dimensions: 64, async embed() { await new Promise(resolve => setTimeout(resolve, 2100)); return opts.embeddingProvider.embed("health"); } };
  try {
    const report = await monitorReport({ ...opts, embeddingProvider: provider });
    expect(report.health.semantic).toBe("available");
    expect(report.failures).toContain("FAILED semantic slow");
    expect(report.failures).not.toContain("FAILED semantic unavailable");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 15000);

test("bootstrap freshness falls back to canonical dates in CLI and the cheap indexed HTTP view", async () => {
  const { root, opts } = setup();
  const old = new Date(Date.now() - 20 * 86_400_000).toISOString();
  const options = { ...opts, monitorStaleDays: { chatgpt: 7, claude: 14, gemini: 21 } };
  try {
    rmSync(join(root, "raw"), { recursive: true });
    mkdirSync(join(root, "raw"));
    rmSync(`${opts.indexPath}.monitor.sqlite`, { force: true });
    const db = openIndex(opts.indexPath);
    for (const capture of [chatgpt, claude, gemini]) {
      const session = readSession(opts.canonicalDir, capture.source, capture.source_id);
      session.updated_at = capture.source === "claude" ? old : new Date().toISOString();
      writeSession(opts.canonicalDir, session);
      indexSession(db, session, { embeddingProvider: opts.embeddingProvider });
    }
    db.close();
    const full = await monitorReport(options);
    expect(full.providers.claude.last_capture_at).toBe(old);
    expect(full.failures).toContain("FAILED freshness.claude stale threshold_days=14");
    expect(full.failures).toContain("FAILED freshness.parsed.claude stale threshold_days=14");
    expect(full.failures.some(line => line.includes("no_captures"))).toBe(false);
    const live = await (await handleIngestRequest(request(), options)).json();
    expect(live.providers.claude.last_capture_at).toBe(old);
    expect(live.failures).toContain("FAILED freshness.claude stale threshold_days=14");
    expect(live.failures).toContain("FAILED freshness.parsed.claude stale threshold_days=14");
    expect(existsSync(`${opts.indexPath}.monitor.sqlite`)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an unwritable state directory is reported even when the database is readable", async () => {
  const { root, opts } = setup();
  const dir = join(root, "telemetry");
  const path = join(dir, "state.sqlite");
  recordCaptureReceipt(path, "chatgpt");
  chmodSync(dir, 0o555);
  try {
    const response = await handleIngestRequest(new Request("http://local/captures", { method: "POST", body: JSON.stringify(claude) }), { ...opts, monitorStatePath: path, ingestToken: null });
    expect(response.status).toBe(200);
    expect((await response.json()).spine[0].indexed).toBe(true);
    const report = await monitorReport({ ...opts, monitorStatePath: path });
    expect(report.failures).toContain("FAILED state unwritable");
    expect(report.failures.some(line => line.includes("freshness"))).toBe(false);
    const live = await (await handleIngestRequest(request(), { ...opts, monitorStatePath: path })).json();
    expect(live.failures).toEqual(["FAILED state unwritable"]);
  } finally { chmodSync(dir, 0o755); rmSync(root, { recursive: true, force: true }); }
});
