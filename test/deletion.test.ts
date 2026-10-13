import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    for (const broken of ["canonical", "raw-gzip", "raw-json", "metadata"]) {
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
        if (broken === "metadata") writeFileSync(`${blob}.json`, '{"private-token');
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
