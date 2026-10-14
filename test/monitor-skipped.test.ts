import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HashEmbeddingProvider } from "../src/indexer/embedding-providers";
import { openIndex } from "../src/indexer/sqlite";
import { cachedLiveMonitorReport, liveMonitorReport } from "../src/monitor/live-report";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "monitor-skipped-"));
  const opts = {
    canonicalDir: join(root, "canonical", "sessions"), indexPath: join(root, "index.db"),
    embeddingProvider: new HashEmbeddingProvider(),
    monitorStaleDays: { chatgpt: null, claude: null, gemini: null },
  };
  for (const path of [opts.canonicalDir, join(root, "raw"), join(root, "canonical", "assets")]) mkdirSync(path, { recursive: true });
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify(opts));
  openIndex(opts.indexPath).close();
  const cli = () => Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli/chat-scrobbler.ts"), "monitor"], {
    env: { ...process.env, CHAT_SCROBBLER_CONFIG: configPath, CANONICAL_DIR: opts.canonicalDir,
      INDEX_PATH: opts.indexPath, CHAT_SCROBBLER_EMBED_PROVIDER: "hash", CHAT_SCROBBLER_MONITOR_STATE_PATH: join(root, "state.sqlite") },
  });
  return { root, opts, cli };
}

function pending(db: Database, id: string, reason: string | null, count: number, kind = "hash", model = "hash-v1", state = "skipped") {
  for (let i = 0; i < count; i++) db.run(`INSERT INTO embedding_pending
    (session_id,message_id,provider_kind,provider_model,input_hash,fts_rowid,type,state,priority,reason,retry_at)
    VALUES ('fixture',?,?,?,?,0,'text',?,'',?,?)`,
    [`${id}-${i}`, kind, model, "private-input", state, reason, Date.now() + 86_400_000]);
}

test("CLI skipped alerts persist, scope the active provider, exclude empty text and break reason ties lexically", () => {
  const { root, opts, cli } = setup();
  try {
    const db = new Database(opts.indexPath);
    pending(db, "item", "retry_exhausted_item_error", 2);
    pending(db, "timeout", "retry_exhausted_request_timeout", 3);
    pending(db, "empty", "empty_text", 8);
    pending(db, "old-model", "retry_exhausted_http_400", 9, "hash", "old-model");
    pending(db, "other-kind", "retry_exhausted_http_400", 9, "ollama");
    for (const state of ["pending", "deferred", "complete"]) pending(db, state, "item_error", 9, "hash", "hash-v1", state);
    db.close();
    const before = readFileSync(opts.indexPath);
    for (let i = 0; i < 2; i++) {
      const result = cli();
      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).toBe("");
      expect(result.stdout.toString()).toBe("FAILED embeddings skipped=5 reason=retry_exhausted_request_timeout\n");
    }
    expect(readFileSync(opts.indexPath)).toEqual(before);
    const update = new Database(opts.indexPath);
    pending(update, "tie", "retry_exhausted_item_error", 1);
    update.close();
    expect(cli().stdout.toString()).toBe("FAILED embeddings skipped=6 reason=retry_exhausted_item_error\n");
    expect(liveMonitorReport(opts).failures).toEqual(["FAILED embeddings skipped=6 reason=retry_exhausted_item_error"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skipped reasons cannot expose persisted text or errors, and live cache respects provider changes", () => {
  const { root, opts, cli } = setup();
  let calls = 0;
  const provider = { kind: "hash", model: "hash-v1", embed() { calls++; throw new Error("must not embed"); } };
  try {
    const db = new Database(opts.indexPath);
    pending(db, "unsafe", "https://secret?token=chat-text\nFAILED injected", 2);
    pending(db, "category", "retry_exhausted_http_400", 1);
    db.close();
    expect(cli().stdout.toString()).toBe("FAILED embeddings skipped=3 reason=unknown\n");
    const live = cachedLiveMonitorReport({ ...opts, embeddingProvider: provider });
    expect(live.failures).toEqual(["FAILED embeddings skipped=3 reason=unknown"]);
    expect(JSON.stringify(live)).not.toContain("secret");
    expect(cachedLiveMonitorReport({ ...opts, embeddingProvider: { ...provider, model: "other-model" } }).failures).toEqual([]);
    expect(cachedLiveMonitorReport({ ...opts, embeddingProvider: { ...provider, kind: "ollama" } }).failures).toEqual([]);
    expect(cachedLiveMonitorReport({ ...opts, embeddingProvider: null }).failures).toEqual([]);
    expect(calls).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("monitor accepts an older index without the pending table and does not migrate it", () => {
  const { root, opts, cli } = setup();
  try {
    const db = new Database(opts.indexPath);
    db.run("DROP TABLE embedding_pending");
    db.close();
    const before = readFileSync(opts.indexPath);
    const result = cli();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe("");
    expect(liveMonitorReport(opts).failures).toEqual([]);
    expect(readFileSync(opts.indexPath)).toEqual(before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
