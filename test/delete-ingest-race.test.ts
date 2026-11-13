// `chat-scrobbler delete` runs in another process than serve. These tests run the
// CLI's deletion at exact points inside an ingest write, after the tombstone check.
import { afterEach, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as rawLatest from "../src/store/raw-latest";
import * as references from "../src/store/asset-reference-store";
import * as sessions from "../src/store/sessions";

let hook: ((point: string, root?: string, id?: string) => void) | null = null;
const realLatestRaw = rawLatest.latestRaw;
const realRecordAssetReferences = references.recordAssetReferences;
const realDeleteSession = sessions.deleteSession;
// Inside the CLI's deletion: after it collected the session's blob hashes, before it removes aliases and owners.
mock.module("../src/store/sessions", () => ({ ...sessions,
  deleteSession: (dir: string, source: string, id: string) => { hook?.("cli-collected", dir, id); return realDeleteSession(dir, source, id); } }));
mock.module("../src/store/raw-latest", () => ({ ...rawLatest, latestRaw: (dir: string) => { hook?.("raw"); return realLatestRaw(dir); } }));
mock.module("../src/store/asset-reference-store", () => ({ ...references,
  recordAssetReferences: (root: string, source: string, id: string, hashes: Set<string>) => {
    hook?.("references", root, id); return realRecordAssetReferences(root, source, id, hashes);
  } }));

const { handleIngestRequest } = await import("../packages/ingest/src/server");
const { buildRawCapture } = await import("../packages/shared/src");
const { deleteSessionEverywhere, SessionDeletedError, writeUnlessDeleted } = await import("../src/core/delete-session");
const { openIndex, listSessions } = await import("../src/indexer/sqlite");
const { listRawCaptures, storeRawCapture } = await import("../src/store/raw");
const { assetsDirForCanonicalDir, assetsDirForSession, assetBlobPath } = await import("../src/store/assets");
const { isSessionDeleted } = await import("../src/store/tombstones");
const sample = (await import("./fixtures/chatgpt-api-sample.json")).default;

const roots: string[] = [];
afterEach(() => { hook = null; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "delete-race-")); roots.push(root);
  return { root, canonicalDir: join(root, "canonical", "sessions"), rawDir: join(root, "raw"), indexPath: join(root, "index.db") };
}
type Opts = ReturnType<typeof setup>;

/** What `chat-scrobbler delete` does, on its own index connection. */
function cliDelete(opts: Opts, sourceId: string) {
  const db = openIndex(opts.indexPath);
  try { deleteSessionEverywhere({ canonicalDir: opts.canonicalDir, rawDir: opts.rawDir, monitorStatePath: join(opts.root, "monitor.json") }, db, "chatgpt", sourceId); }
  finally { db.close(); }
}
const capture = (sourceId: string, text: string) => {
  const value = structuredClone(sample) as any;
  value.source_id = sourceId;
  value.payload.conversation_id = sourceId;
  value.payload.mapping.n1.message.content.parts[0] = text;
  return value;
};
const post = (opts: Opts, body: unknown) => handleIngestRequest(new Request("http://local/captures", { method: "POST", body: JSON.stringify(body) }), opts);
function indexed(opts: Opts): string[] {
  const db = openIndex(opts.indexPath);
  try { return listSessions(db, {}).map(session => session.id); } finally { db.close(); }
}
function expectErased(opts: Opts, sourceId: string) {
  expect(isSessionDeleted(opts.canonicalDir, "chatgpt", sourceId)).toBe(true);
  expect(listRawCaptures(opts.rawDir, "chatgpt", sourceId)).toEqual([]);
  expect(existsSync(join(opts.rawDir, "chatgpt", sourceId))).toBe(false);
  expect(existsSync(join(opts.canonicalDir, "chatgpt", `${sourceId}.json`))).toBe(false);
  expect(existsSync(assetsDirForSession(opts.canonicalDir, "chatgpt", sourceId))).toBe(false);
  expect(indexed(opts)).not.toContain(`chatgpt:${sourceId}`);
}

for (const [point, inside] of [
  ["before the raw version is written", (p: string) => p === "raw"],
  ["before the canonical session is written", (p: string, root?: string, id?: string, opts?: Opts) => p === "references" && root === opts!.canonicalDir && id === "gone"],
] as const) {
  test(`a CLI delete landing ${point} leaves nothing of the session, and a live session in the batch is kept`, async () => {
    const opts = setup();
    expect((await post(opts, capture("gone", "first"))).status).toBe(200);
    let deleted = false;
    hook = (p, root, id) => {
      if (deleted || !(inside as (p: string, root?: string, id?: string, opts?: Opts) => boolean)(p, root, id, opts)) return;
      deleted = true;
      cliDelete(opts, "gone");
    };
    const response = await post(opts, [capture("live", "kept"), capture("gone", "second")]);
    hook = null;
    expect(deleted).toBe(true);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.skipped_deleted).toEqual([{ source: "chatgpt", source_id: "gone" }]);
    expect(body.spine.map((entry: any) => entry.source_id)).toEqual(["live"]);
    expectErased(opts, "gone");
    expect(listRawCaptures(opts.rawDir, "chatgpt", "live")).toHaveLength(1);
    expect(existsSync(join(opts.canonicalDir, "chatgpt", "live.json"))).toBe(true);
    expect(indexed(opts)).toContain("chatgpt:live");
  }, 30000);
}

test("a CLI delete landing after the capture is fully written is erased by the CLI itself", async () => {
  const opts = setup();
  expect((await post(opts, capture("gone", "first"))).status).toBe(200);
  cliDelete(opts, "gone");
  expectErased(opts, "gone");
});

test("a CLI delete landing during an asset upload leaves no alias, ownership record or private blob", async () => {
  const opts = setup();
  expect((await post(opts, capture("gone", "first"))).status).toBe(200);
  const assetsDir = assetsDirForCanonicalDir(opts.canonicalDir);
  let deleted = false;
  hook = (p, root, id) => { if (!deleted && p === "references" && root === assetsDir && id === "gone") { deleted = true; cliDelete(opts, "gone"); } };
  const response = await handleIngestRequest(new Request("http://local/assets?source=chatgpt&source_id=gone&pointer=p", { method: "POST", body: "private bytes" }), opts);
  hook = null;
  expect(deleted).toBe(true);
  expect(response.status).toBe(410);
  expectErased(opts, "gone");
  const sha = new Bun.CryptoHasher("sha256").update("private bytes").digest("hex");
  expect(existsSync(assetBlobPath(opts.canonicalDir, sha))).toBe(false);
  expect(references.ownedAssetHashes(assetsDir, "chatgpt", "gone").size).toBe(0);
}, 30000);

test("a session that was never tombstoned is untouched by the recheck", async () => {
  const opts = setup();
  storeRawCapture(opts.rawDir, buildRawCapture({ source: "chatgpt", sourceId: "other", endpoint: "/detail", payload: { p: 1 } }));
  expect((await post(opts, capture("live", "kept"))).status).toBe(200);
  expect(readdirSync(join(opts.rawDir, "chatgpt")).sort()).toEqual(["live", "other"]);
  expect(indexed(opts)).toEqual(["chatgpt:live"]);
});

test("a CLI delete landing during an asset backfill leaves nothing of the session", async () => {
  const opts = setup();
  const mapping = {
    root: { id: "root", message: null, parent: null, children: ["u1"] },
    u1: { id: "u1", parent: "root", children: ["a1"], message: { id: "u1", author: { role: "user" }, create_time: 1, recipient: "all", metadata: {},
      content: { content_type: "text", parts: ["hello"] } } },
    a1: { id: "a1", parent: "u1", children: [], message: { id: "a1", author: { role: "assistant" }, create_time: 2, recipient: "all", metadata: {},
      content: { content_type: "multimodal_text", parts: [{ content_type: "image_asset_pointer", asset_pointer: "file-service://file-EXP" }] } } },
  };
  expect((await post(opts, buildRawCapture({ source: "chatgpt", sourceId: "gone", endpoint: "/backend-api/conversation/x",
    payload: { conversation_id: "gone", title: "t", current_node: "a1", mapping } }))).status).toBe(200);
  const upload = await handleIngestRequest(new Request("http://local/assets?source=chatgpt&source_id=gone&pointer=p&filename=gen.png", { method: "POST", headers: { "content-type": "image/png" }, body: "image bytes" }), opts);
  const { sha256 } = await upload.json() as any;
  let deleted = false;
  hook = p => { if (!deleted && p === "raw") { deleted = true; cliDelete(opts, "gone"); } };
  const response = await handleIngestRequest(new Request("http://local/assets/backfill", { method: "POST", body: JSON.stringify({ source: "chatgpt", source_id: "gone", assets: [
    { pointer: "file-service://file-EXP", message_id: "a1", filename: "gen.png", content_type: "image/png", sha256 }] }) }), opts);
  hook = null;
  expect(deleted).toBe(true);
  expect(response.status).toBe(410);
  expectErased(opts, "gone");
  expect(existsSync(assetBlobPath(opts.canonicalDir, sha256))).toBe(false);
}, 30000);

test("an upload the CLI deletion missed after collecting hashes still has its private blob erased", async () => {
  const opts = setup();
  expect((await post(opts, capture("gone", "first"))).status).toBe(200);
  const assetsDir = assetsDirForCanonicalDir(opts.canonicalDir);
  const bytes = Buffer.from("late private bytes");
  const sha = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const { writeImmutableFile } = await import("../src/store/immutable-file");
  const { linkSync, mkdirSync } = await import("node:fs");
  const db = openIndex(opts.indexPath);
  try {
    const paths = { canonicalDir: opts.canonicalDir, rawDir: opts.rawDir, monitorStatePath: join(opts.root, "monitor.json") };
    // storeCanonicalAsset passed its tombstone assert; its writes land inside the CLI's deletion.
    const upload = () => {
      hook = p => {
        if (p !== "cli-collected") return;
        hook = null;
        realRecordAssetReferences(assetsDir, "chatgpt", "gone", new Set([sha]));
        writeImmutableFile(assetBlobPath(opts.canonicalDir, sha), bytes);
        mkdirSync(assetsDirForSession(opts.canonicalDir, "chatgpt", "gone"), { recursive: true });
        linkSync(assetBlobPath(opts.canonicalDir, sha), join(assetsDirForSession(opts.canonicalDir, "chatgpt", "gone"), `${sha}.bin`));
      };
      cliDelete(opts, "gone");
    };
    expect(() => writeUnlessDeleted(paths, db, "chatgpt", "gone", upload, new Set([sha]))).toThrow(SessionDeletedError);
  } finally { db.close(); }
  expectErased(opts, "gone");
  expect(existsSync(assetBlobPath(opts.canonicalDir, sha))).toBe(false);
}, 30000);

test("the recheck covers the session id a capture's payload names, not only its envelope id", async () => {
  const opts = setup();
  const mismatched = capture("gone", "second");
  mismatched.source_id = "other-envelope";
  let deleted = false;
  hook = (p, root, id) => { if (!deleted && p === "references" && root === opts.canonicalDir && id === "gone") { deleted = true; cliDelete(opts, "gone"); } };
  const response = await post(opts, mismatched);
  hook = null;
  expect(deleted).toBe(true);
  const body = await response.json() as any;
  expect(body.spine.map((entry: any) => entry.source_id)).not.toContain("gone");
  expect(existsSync(join(opts.canonicalDir, "chatgpt", "gone.json"))).toBe(false);
  expect(indexed(opts)).not.toContain("chatgpt:gone");
}, 30000);

test("a capture holding several conversations rechecks each one written, and skips only a deleted one", async () => {
  const opts = setup();
  const claude = (await import("./fixtures/claude-api-sample.json")).default as any;
  const conversation = (uuid: string) => ({ ...structuredClone(claude.payload), uuid });
  const { markSessionDeleted } = await import("../src/store/tombstones");
  markSessionDeleted(opts.canonicalDir, { source: "claude", source_id: "y2", deleted_at: "2026-10-13T00:00:00Z" });
  let deleted = false;
  hook = (p, root, id) => {
    if (deleted || p !== "references" || root !== opts.canonicalDir || id !== "y1") return;
    deleted = true;
    const db = openIndex(opts.indexPath);
    try { deleteSessionEverywhere({ canonicalDir: opts.canonicalDir, rawDir: opts.rawDir, monitorStatePath: join(opts.root, "monitor.json") }, db, "claude", "y1"); }
    finally { db.close(); }
  };
  const response = await post(opts, { ...claude, source_id: "batch", payload: [conversation("y1"), conversation("y2"), conversation("y3")] });
  hook = null;
  expect(deleted).toBe(true);
  expect(response.status).toBe(200);
  const body = await response.json() as any;
  expect(body.spine.map((entry: any) => entry.source_id)).toEqual(["y3"]);
  for (const id of ["y1", "y2"]) expect(existsSync(join(opts.canonicalDir, "claude", `${id}.json`))).toBe(false);
  expect(existsSync(join(opts.canonicalDir, "claude", "y3.json"))).toBe(true);
}, 30000);
