import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRawCapture } from "../packages/shared/src";
import { runDeleteCmd } from "../src/cli/delete";
import { DEFAULT_CONFIG, type ChatHistoryConfig } from "../src/config";
import { indexSession, listSessions, openIndex } from "../src/indexer/sqlite";
import { assetBlobPath, storeCanonicalAsset } from "../src/store/assets";
import { listRawCaptures, storeRawCapture } from "../src/store/raw";
import { writeSession } from "../src/store/sessions";
import { isSessionDeleted } from "../src/store/tombstones";
import type { Session } from "../src/schema/types";

const entry = join(import.meta.dir, "../src/cli/chat-scrobbler.ts");

function session(id: string): Session {
  return { id: `chatgpt:${id}`, source: "chatgpt", source_id: id, title: id, created_at: "2025-01-01", updated_at: "2025-01-01",
    capture_method: "api", default_model: null, account: null, raw_ref: "", schema_version: 1,
    messages: [{ id: "m1", role: "user", created_at: null, parent_id: null, model: null, blocks: [{ type: "text", text: `hello ${id}` }], text: `hello ${id}` }] };
}

/** Two indexed sessions with raw history; "gone" owns one private blob and shares another with "keep". */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "cli-delete-"));
  const canonicalDir = join(root, "canonical", "sessions");
  const rawDir = join(root, "raw");
  const indexPath = join(root, "index.db");
  const cfg: ChatHistoryConfig = { ...DEFAULT_CONFIG, canonicalDir, indexPath, monitorStatePath: join(root, "monitor.sqlite") };
  const db = openIndex(indexPath);
  for (const id of ["gone", "keep"]) { writeSession(canonicalDir, session(id)); indexSession(db, session(id)); }
  db.close();
  const asset = (id: string, pointer: string, value: string) => storeCanonicalAsset({ canonicalDir, source: "chatgpt", sourceId: id, pointer, bytes: Buffer.from(value) });
  const privateBlob = asset("gone", "p", "private");
  const shared = asset("gone", "s", "shared"); asset("keep", "s", "shared");
  storeRawCapture(rawDir, buildRawCapture({ source: "chatgpt", sourceId: "gone", endpoint: "/detail", payload: { v: 1 } }));
  storeRawCapture(rawDir, buildRawCapture({ source: "chatgpt", sourceId: "gone", endpoint: "/detail", payload: { v: 2 } }));
  storeRawCapture(rawDir, buildRawCapture({ source: "chatgpt", sourceId: "keep", endpoint: "/detail", payload: { v: 1 } }));
  const indexed = () => { const db = openIndex(indexPath); try { return listSessions(db).map(row => row.id); } finally { db.close(); } };
  return { root, canonicalDir, rawDir, indexPath, cfg, privateBlob, shared, indexed };
}

test("delete --dry-run reports what would be removed and changes nothing", async () => {
  const s = setup();
  const out: string[] = [];
  try {
    const result = await runDeleteCmd({ cfg: s.cfg, id: "chatgpt:gone", dryRun: true, write: line => out.push(line) });
    expect(result).toBe("dry_run");
    const text = out.join("\n");
    expect(text).toContain(join(s.canonicalDir, "chatgpt", "gone.json"));
    expect(text).toContain("raw versions:   2");
    expect(text).toContain("private blobs:  1");
    expect(text).toContain("index:          1 session row, 1 message");
    expect(existsSync(join(s.canonicalDir, "chatgpt", "gone.json"))).toBe(true);
    expect(listRawCaptures(s.rawDir, "chatgpt", "gone")).toHaveLength(2);
    expect(existsSync(assetBlobPath(s.canonicalDir, s.privateBlob.sha256))).toBe(true);
    expect(s.indexed()).toContain("chatgpt:gone");
    expect(isSessionDeleted(s.canonicalDir, "chatgpt", "gone")).toBe(false);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test("delete erases the archive, private blobs and index rows, and keeps everything else", async () => {
  const s = setup();
  const out: string[] = [];
  try {
    expect(await runDeleteCmd({ cfg: s.cfg, id: "chatgpt:gone", yes: true, write: line => out.push(line) })).toBe("deleted");
    expect(existsSync(join(s.canonicalDir, "chatgpt", "gone.json"))).toBe(false);
    expect(listRawCaptures(s.rawDir, "chatgpt", "gone")).toEqual([]);
    expect(existsSync(assetBlobPath(s.canonicalDir, s.privateBlob.sha256))).toBe(false);
    expect(existsSync(assetBlobPath(s.canonicalDir, s.shared.sha256))).toBe(true);
    expect(s.indexed()).toEqual(["chatgpt:keep"]);
    expect(isSessionDeleted(s.canonicalDir, "chatgpt", "gone")).toBe(true);
    expect(out.join("\n")).toContain("Deleted chatgpt:gone");
    // Repeating it is harmless.
    expect(await runDeleteCmd({ cfg: s.cfg, id: "chatgpt:gone", yes: true, write: line => out.push(line) })).toBe("already_deleted");
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test("delete asks before erasing and does nothing when the answer is no", async () => {
  const s = setup();
  const prompts: string[] = [];
  try {
    const declined = await runDeleteCmd({ cfg: s.cfg, id: "chatgpt:gone", write: () => {}, confirm: async prompt => { prompts.push(prompt); return false; } });
    expect(declined).toBe("aborted");
    expect(prompts[0]).toContain("chatgpt:gone");
    expect(s.indexed()).toContain("chatgpt:gone");
    expect(isSessionDeleted(s.canonicalDir, "chatgpt", "gone")).toBe(false);
    expect(await runDeleteCmd({ cfg: s.cfg, id: "chatgpt:gone", write: () => {}, confirm: async () => true })).toBe("deleted");
    expect(isSessionDeleted(s.canonicalDir, "chatgpt", "gone")).toBe(true);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test("delete refuses invalid ids and ids with nothing archived, without writing a tombstone", async () => {
  const s = setup();
  try {
    await expect(runDeleteCmd({ cfg: s.cfg, id: "gone", yes: true, write: () => {} })).rejects.toThrow(/source:source_id/);
    await expect(runDeleteCmd({ cfg: s.cfg, id: "chatgpt:../gone", yes: true, write: () => {} })).rejects.toThrow(/unsafe/);
    await expect(runDeleteCmd({ cfg: s.cfg, id: "chatgpt:missing", yes: true, write: () => {} })).rejects.toThrow(/nothing archived/);
    expect(isSessionDeleted(s.canonicalDir, "chatgpt", "missing")).toBe(false);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test("CLI delete without --yes refuses when stdin is not a terminal", () => {
  const s = setup();
  const config = join(s.root, "config.json");
  writeFileSync(config, JSON.stringify({ monitorStatePath: s.cfg.monitorStatePath }));
  const env = { ...process.env, HOME: s.root, CHAT_SCROBBLER_CONFIG: config, CANONICAL_DIR: s.canonicalDir, INDEX_PATH: s.indexPath, CHAT_SCROBBLER_EMBED_PROVIDER: "none" };
  const cli = (...args: string[]) => Bun.spawnSync([process.execPath, entry, ...args], { env, stdin: "ignore" });
  try {
    const refused = cli("delete", "chatgpt:gone");
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr.toString()).toContain("--yes");
    expect(s.indexed()).toContain("chatgpt:gone");
    const dry = cli("delete", "chatgpt:gone", "--dry-run", "--json");
    expect(dry.exitCode).toBe(0);
    expect(JSON.parse(dry.stdout.toString())).toMatchObject({ id: "chatgpt:gone", raw_versions: 2, private_blobs: 1 });
    const done = cli("delete", "chatgpt:gone", "--yes");
    expect(done.exitCode).toBe(0);
    expect(s.indexed()).toEqual(["chatgpt:keep"]);
    expect(cli("delete", "chatgpt:missing", "--yes").exitCode).toBe(1);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
}, 30000);

test("a deletion whose blob collection is deferred reports it and finishes on the next run", async () => {
  const s = setup();
  const out: string[] = [];
  const errors = (await import("bun:test")).spyOn(console, "error").mockImplementation(() => {});
  try {
    // An unreadable raw version defers blob collection.
    const [ref] = listRawCaptures(s.rawDir, "chatgpt", "gone");
    writeFileSync(join(s.rawDir, ref), "not gzip");
    expect(await runDeleteCmd({ cfg: s.cfg, id: "chatgpt:gone", yes: true, write: line => out.push(line) })).toBe("cleanup_pending");
    expect(out.join("\n")).toContain("Run the same delete again");
    expect(existsSync(assetBlobPath(s.canonicalDir, s.privateBlob.sha256))).toBe(true);
    // The rerun finds the recorded candidates even though every reference is gone.
    expect(await runDeleteCmd({ cfg: s.cfg, id: "chatgpt:gone", yes: true, write: line => out.push(line) })).toBe("deleted");
    expect(existsSync(assetBlobPath(s.canonicalDir, s.privateBlob.sha256))).toBe(false);
    expect(existsSync(assetBlobPath(s.canonicalDir, s.shared.sha256))).toBe(true);
    expect(await runDeleteCmd({ cfg: s.cfg, id: "chatgpt:gone", yes: true, write: () => {} })).toBe("already_deleted");
  } finally { errors.mockRestore(); rmSync(s.root, { recursive: true, force: true }); }
});

test("a deletion interrupted before blob collection is finished by the next run", async () => {
  if (process.getuid?.() === 0) return;
  const { chmodSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const s = setup();
  const blobDir = dirname(assetBlobPath(s.canonicalDir, s.privateBlob.sha256));
  try {
    chmodSync(blobDir, 0o500);
    await expect(runDeleteCmd({ cfg: s.cfg, id: "chatgpt:gone", yes: true, write: () => {} })).rejects.toThrow();
    chmodSync(blobDir, 0o700);
    const out: string[] = [];
    expect(await runDeleteCmd({ cfg: s.cfg, id: "chatgpt:gone", dryRun: true, write: line => out.push(line) })).toBe("dry_run");
    expect(out.join("\n")).toContain("private blobs:  1");
    expect(await runDeleteCmd({ cfg: s.cfg, id: "chatgpt:gone", yes: true, write: () => {} })).toBe("deleted");
    expect(existsSync(assetBlobPath(s.canonicalDir, s.privateBlob.sha256))).toBe(false);
  } finally { chmodSync(blobDir, 0o700); rmSync(s.root, { recursive: true, force: true }); }
});
