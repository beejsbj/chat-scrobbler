import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleIngestRequest } from "../packages/ingest/src/server";
import { buildRawCapture } from "../packages/shared/src";
import { assetBlobPath, storeCanonicalAsset } from "../src/store/assets";
import { listRawCaptures, storeRawCapture } from "../src/store/raw";
import { writeSession } from "../src/store/sessions";
import { createBackup, restoreBackup } from "../src/backup/backup";
import { LocalDirTarget } from "../src/backup/local";
import { indexSession, listSessions, openIndex } from "../src/indexer/sqlite";
import type { Session } from "../src/schema/types";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "delete-archive-")); roots.push(root);
  return { root, canonicalDir: join(root, "canonical", "sessions"), rawDir: join(root, "custom-raw"), indexPath: join(root, "index.db") };
}
function session(id: string): Session {
  return { id: `chatgpt:${id}`, source: "chatgpt", source_id: id, title: id, created_at: "2025-01-01", updated_at: "2025-01-01", capture_method: "api", default_model: null, account: null, raw_ref: "", schema_version: 1, messages: [] };
}

test("delete erases raw, private blobs and aliases, preserves shared blobs, and prevents recapture", async () => {
  const opts = setup();
  writeSession(opts.canonicalDir, session("gone"));
  const upload = (sourceId: string, value: string) => storeCanonicalAsset({ canonicalDir: opts.canonicalDir, source: "chatgpt", sourceId, pointer: "pointer", bytes: Buffer.from(value) });
  const privateAsset = upload("gone", "private");
  const shared = upload("gone", "shared"); upload("remaining", "shared");
  const capture = buildRawCapture({ source: "chatgpt", sourceId: "gone", endpoint: "/detail", payload: { widget: "secret" } });
  storeRawCapture(opts.rawDir, capture);
  const response = await handleIngestRequest(new Request("http://local/captures?source=chatgpt&source_id=gone", { method: "DELETE" }), opts);
  expect(response.status).toBe(200);
  expect(listRawCaptures(opts.rawDir, "chatgpt", "gone")).toEqual([]);
  expect(existsSync(assetBlobPath(opts.canonicalDir, privateAsset.sha256))).toBe(false);
  expect(existsSync(`${assetBlobPath(opts.canonicalDir, privateAsset.sha256)}.json`)).toBe(false);
  expect(existsSync(assetBlobPath(opts.canonicalDir, shared.sha256))).toBe(true);
  expect(existsSync(join(opts.root, "canonical", privateAsset.local_path))).toBe(false);
  const tombstone = JSON.parse(readFileSync(join(opts.canonicalDir, ".deleted", "chatgpt", "gone.json"), "utf8"));
  expect(Object.keys(tombstone).sort()).toEqual(["deleted_at", "source", "source_id"]);
  expect(() => writeSession(opts.canonicalDir, session("gone"))).toThrow(/deleted/);
  const recapture = await handleIngestRequest(new Request("http://local/captures", { method: "POST", body: JSON.stringify(capture) }), opts);
  expect(recapture.status).toBe(200);
  expect(await recapture.json()).toMatchObject({ ok: true, count: 0, skipped_deleted: [{ source: "chatgpt", source_id: "gone" }] });
  expect(listRawCaptures(opts.rawDir, "chatgpt", "gone")).toEqual([]);
  expect((await handleIngestRequest(new Request("http://local/assets?source=chatgpt&source_id=gone&pointer=p", { method: "POST", body: "again" }), opts)).status).toBe(410);
  expect((await handleIngestRequest(new Request("http://local/captures?source=chatgpt&source_id=gone", { method: "DELETE" }), opts)).status).toBe(200);
});

test("new backups preserve deletion tombstones and restore skips deleted session content", async () => {
  const opts = setup();
  writeSession(opts.canonicalDir, session("gone"));
  writeSession(opts.canonicalDir, session("remaining"));
  await handleIngestRequest(new Request("http://local/captures?source=chatgpt&source_id=gone", { method: "DELETE" }), opts);
  const target = new LocalDirTarget(join(opts.root, "backups"));
  const { snapshot } = await createBackup({ ...opts, target });
  expect(target.listFiles(snapshot)).toContain("deleted/chatgpt/gone.json");
  // Simulate stale data in a snapshot taken concurrently with deletion.
  const stale = setup();
  const file = writeSession(stale.canonicalDir, session("gone"));
  await target.putFile(snapshot, "canonical/chatgpt/gone.json", file);
  const capture = buildRawCapture({ source: "chatgpt", sourceId: "gone", endpoint: "/detail", payload: { stale: true } });
  const ref = storeRawCapture(stale.rawDir, capture);
  await target.putFile(snapshot, `raw/${ref}`, join(stale.rawDir, ref));
  const restored = setup();
  const result = await restoreBackup({ ...restored, target, snapshot });
  expect(result.restored_count).toBe(1);
  expect(result.restored_raw_count).toBe(0);
  expect(existsSync(join(restored.canonicalDir, "chatgpt", "gone.json"))).toBe(false);
  expect(() => writeSession(restored.canonicalDir, session("gone"))).toThrow(/deleted/);
});

test("blob collection respects surviving raw references without upload aliases", async () => {
  const opts = setup();
  const asset = storeCanonicalAsset({ canonicalDir: opts.canonicalDir, source: "chatgpt", sourceId: "gone", pointer: "p", bytes: Buffer.from("shared raw") });
  const capture = buildRawCapture({ source: "chatgpt", sourceId: "raw-owner", endpoint: "/detail", payload: {}, assets: [{ pointer: "p", sha256: asset.sha256, local_path: "" }] });
  storeRawCapture(opts.rawDir, capture);
  const remove = (id: string) => handleIngestRequest(new Request(`http://local/captures?source=chatgpt&source_id=${id}`, { method: "DELETE" }), opts);
  expect((await remove("gone")).status).toBe(200);
  expect(existsSync(assetBlobPath(opts.canonicalDir, asset.sha256))).toBe(true);
  expect((await remove("raw-owner")).status).toBe(200);
  expect(existsSync(assetBlobPath(opts.canonicalDir, asset.sha256))).toBe(false);
});


test("mixed capture batches archive and index live entries while acknowledging deleted entries", async () => {
  const opts = setup();
  await handleIngestRequest(new Request("http://local/captures?source=chatgpt&source_id=gone", { method: "DELETE" }), opts);
  const fixture = (await import("./fixtures/chatgpt-api-sample.json")).default;
  const deleted = { ...fixture, source_id: "gone" };
  const exactLive = JSON.stringify(fixture, null, 3);
  const response = await handleIngestRequest(new Request("http://local/captures", { method: "POST", body: `[${JSON.stringify(deleted)},${exactLive},${JSON.stringify(deleted)}]` }), opts);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, count: 1, skipped_deleted: [{ source: "chatgpt", source_id: "gone" }, { source: "chatgpt", source_id: "gone" }], spine: [{ indexed: true }] });
  expect(listRawCaptures(opts.rawDir, "chatgpt", "gone")).toHaveLength(0);
  const refs = listRawCaptures(opts.rawDir, fixture.source, fixture.source_id);
  expect(refs).toHaveLength(1);
  expect(Buffer.from(Bun.gunzipSync(readFileSync(join(opts.rawDir, refs[0])))).toString()).toBe(exactLive);
});


test("corrupt canonical, raw or asset metadata cannot prevent deleting projections and archive files", async () => {
  const logs = (await import("bun:test")).spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const broken of ["canonical", "raw-gzip", "raw-json", "metadata", "ownership"]) {
      const opts = setup();
      const file = writeSession(opts.canonicalDir, session("gone"));
      const db = openIndex(opts.indexPath);
      try {
        indexSession(db, session("gone"));
        const asset = storeCanonicalAsset({ canonicalDir: opts.canonicalDir, source: "chatgpt", sourceId: "gone", pointer: "p", bytes: Buffer.from("private") });
        const ref = storeRawCapture(opts.rawDir, buildRawCapture({ source: "chatgpt", sourceId: "gone", endpoint: "/detail", payload: {} }));
        const blob = assetBlobPath(opts.canonicalDir, asset.sha256);
        if (broken === "canonical") writeFileSync(file, '{"private-token');
        if (broken === "raw-gzip") writeFileSync(join(opts.rawDir, ref), "invalid gzip private-token");
        if (broken === "raw-json") writeFileSync(join(opts.rawDir, ref), Bun.gzipSync(Buffer.from('{"private-token')));
        if (broken === "metadata") {
          // Reproduce a legacy upload with no write-time ownership catalogue.
          rmSync(join(opts.root, "canonical", "assets", ".asset-refs"), { recursive: true, force: true });
          writeFileSync(`${blob}.json`, '{"private-token');
        }
        if (broken === "ownership") writeFileSync(join(opts.root, "canonical", "assets", ".asset-refs", "owners", "chatgpt", "gone.json"), '{"private-token');
        for (let attempt = 0; attempt < 2; attempt++) {
          const response = await handleIngestRequest(new Request("http://local/captures?source=chatgpt&source_id=gone", { method: "DELETE" }), opts);
          expect(response.status).toBe(200);
          expect(listSessions(db)).toHaveLength(0);
          expect(existsSync(file)).toBe(false);
          expect(existsSync(join(opts.rawDir, "chatgpt", "gone"))).toBe(false);
          expect(existsSync(join(opts.root, "canonical", asset.local_path))).toBe(false);
          // The corrupt run cannot establish safe ownership, so retains uncertain CAS bytes.
          if (attempt === 0) expect(existsSync(blob)).toBe(true);
        }
      } finally { db.close(); }
    }
    expect(JSON.stringify(logs.mock.calls)).toContain("asset_cleanup_deferred");
    expect(JSON.stringify(logs.mock.calls)).not.toContain("private-token");
  } finally { logs.mockRestore(); }
});

test("asset-free deletion never gunzips the surviving archive", async () => {
  const opts = setup();
  writeSession(opts.canonicalDir, session("gone"));
  storeRawCapture(opts.rawDir, buildRawCapture({ source: "chatgpt", sourceId: "remaining", endpoint: "/detail", payload: {} }));
  const unzip = (await import("bun:test")).spyOn(Bun, "gunzipSync");
  try {
    const response = await handleIngestRequest(new Request("http://local/captures?source=chatgpt&source_id=gone", { method: "DELETE" }), opts);
    expect(response.status).toBe(200);
    expect(unzip).not.toHaveBeenCalled();
  } finally { unzip.mockRestore(); }
});

test("write-time asset ownership avoids scanning other captures during blob cleanup", async () => {
  const opts = setup();
  const shared = storeCanonicalAsset({ canonicalDir: opts.canonicalDir, source: "chatgpt", sourceId: "gone", pointer: "p", bytes: Buffer.from("shared") });
  const privateAsset = storeCanonicalAsset({ canonicalDir: opts.canonicalDir, source: "chatgpt", sourceId: "gone", pointer: "q", bytes: Buffer.from("private") });
  storeRawCapture(opts.rawDir, buildRawCapture({ source: "chatgpt", sourceId: "remaining", endpoint: "/detail", payload: {}, assets: [{ pointer: "p", local_path: "", sha256: shared.sha256 }] }));
  const unzip = (await import("bun:test")).spyOn(Bun, "gunzipSync");
  try {
    const response = await handleIngestRequest(new Request("http://local/captures?source=chatgpt&source_id=gone", { method: "DELETE" }), opts);
    expect(response.status).toBe(200);
    expect(existsSync(assetBlobPath(opts.canonicalDir, shared.sha256))).toBe(true);
    expect(existsSync(assetBlobPath(opts.canonicalDir, privateAsset.sha256))).toBe(false);
    expect(unzip).not.toHaveBeenCalled();
  } finally { unzip.mockRestore(); }
});

test("restore cleans many tombstones with at most one surviving archive scan", async () => {
  const opts = setup();
  const { markSessionDeleted } = await import("../src/store/tombstones");
  const privateHashes: string[] = [];
  for (const id of ["gone-a", "gone-b", "gone-c"]) {
    const asset = storeCanonicalAsset({ canonicalDir: opts.canonicalDir, source: "chatgpt", sourceId: id, pointer: id, bytes: Buffer.from(id) });
    privateHashes.push(asset.sha256);
    markSessionDeleted(opts.canonicalDir, { source: "chatgpt", source_id: id, deleted_at: "2026-01-01T00:00:00Z" });
  }
  storeRawCapture(opts.rawDir, buildRawCapture({ source: "chatgpt", sourceId: "remaining", endpoint: "/detail", payload: {} }));
  const target = new LocalDirTarget(join(opts.root, "backups"));
  const { snapshot } = await createBackup({ ...opts, target });
  const restored = setup();
  const unzip = (await import("bun:test")).spyOn(Bun, "gunzipSync");
  try {
    await restoreBackup({ ...restored, target, snapshot });
    for (const hash of privateHashes) expect(existsSync(assetBlobPath(restored.canonicalDir, hash))).toBe(false);
    // One read to restore the capture, plus at most one read to initialize legacy ownership.
    expect(unzip.mock.calls.length).toBeLessThanOrEqual(2);
  } finally { unzip.mockRestore(); }
});


test("legacy ownership is initialized once and subsequent deletion uses reference records", async () => {
  const opts = setup();
  const shared = storeCanonicalAsset({ canonicalDir: opts.canonicalDir, source: "chatgpt", sourceId: "gone", pointer: "p", bytes: Buffer.from("shared") });
  const legacy = buildRawCapture({ source: "chatgpt", sourceId: "remaining", endpoint: "/detail", payload: {}, assets: [{ pointer: "p", local_path: "", sha256: shared.sha256 }] });
  const legacyDir = join(opts.rawDir, "chatgpt", "remaining");
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, `old-${"a".repeat(64)}.json.gz`), Bun.gzipSync(Buffer.from(JSON.stringify(legacy))));
  const unzip = (await import("bun:test")).spyOn(Bun, "gunzipSync");
  try {
    const remove = (id: string) => handleIngestRequest(new Request(`http://local/captures?source=chatgpt&source_id=${id}`, { method: "DELETE" }), opts);
    expect((await remove("gone")).status).toBe(200);
    expect(existsSync(assetBlobPath(opts.canonicalDir, shared.sha256))).toBe(true);
    expect(unzip.mock.calls.length).toBe(1);
    const later = storeCanonicalAsset({ canonicalDir: opts.canonicalDir, source: "chatgpt", sourceId: "later", pointer: "q", bytes: Buffer.from("private") });
    expect((await remove("later")).status).toBe(200);
    expect(existsSync(assetBlobPath(opts.canonicalDir, later.sha256))).toBe(false);
    expect(unzip.mock.calls.length).toBe(1);
  } finally { unzip.mockRestore(); }
});

test("session ownership keeps historical asset links collectable after canonical replacement", async () => {
  const opts = setup();
  const asset = storeCanonicalAsset({ canonicalDir: opts.canonicalDir, source: "chatgpt", sourceId: "gone", pointer: "p", bytes: Buffer.from("historical") });
  const linked = session("remaining");
  linked.messages = [{ id: "m", role: "user", parent_id: null, model: null, created_at: null, text: "", blocks: [{ type: "attachment", kind: "file", filename: null, pointer: "p", sha256: asset.sha256, local_path: null }] }];
  writeSession(opts.canonicalDir, linked);
  const remove = (id: string) => handleIngestRequest(new Request(`http://local/captures?source=chatgpt&source_id=${id}`, { method: "DELETE" }), opts);
  await remove("gone");
  expect(existsSync(assetBlobPath(opts.canonicalDir, asset.sha256))).toBe(true);
  writeSession(opts.canonicalDir, session("remaining"));
  await remove("remaining");
  expect(existsSync(assetBlobPath(opts.canonicalDir, asset.sha256))).toBe(false);
});
