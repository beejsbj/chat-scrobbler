import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { buildRawCapture } from "../packages/shared/src";
import { archiveCaptureWithGeminiMedia } from "../packages/ingest/src/gemini-media-retention";
import { createBackup, restoreBackup } from "../src/backup/backup";
import { LocalDirTarget } from "../src/backup/local";
import type { BackupTarget } from "../src/backup/target";
import { reparse } from "../src/core/reparse";
import { latestRawReference } from "../src/store/raw-catalog";
import { latestRaw } from "../src/store/raw-latest";
import { listRawCaptures, rawDirForCanonicalDir, storeRawCapture } from "../src/store/raw";
import { readSession } from "../src/store/sessions";
import sample from "./fixtures/chatgpt-api-sample.json";

const temps: string[] = [];
const makeTmp = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); temps.push(dir); return dir; };
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** Lists the snapshot in a fixed order and writes slowly, so restore mtimes follow that order. */
class OrderedTarget implements BackupTarget {
  constructor(private readonly inner: LocalDirTarget, private readonly reverse = false) {}
  putFile(snapshot: string, relPath: string, src: string) { return this.inner.putFile(snapshot, relPath, src); }
  async getFile(snapshot: string, relPath: string, dest: string) { await Bun.sleep(5); return this.inner.getFile(snapshot, relPath, dest); }
  listFiles(snapshot: string) { const files = this.inner.listFiles(snapshot).sort(); return this.reverse ? files.reverse() : files; }
  listSnapshots() { return this.inner.listSnapshots(); }
  describe() { return this.inner.describe(); }
}

function version(text: string, fetchedAt: string) {
  const capture = structuredClone(sample) as any;
  capture.payload.mapping.n1.message.content.parts[0] = text;
  capture.fetched_at = fetchedAt;
  return capture;
}

function store(prefix: string) {
  const root = makeTmp(prefix);
  const canonicalDir = join(root, "canonical", "sessions");
  return { root, canonicalDir, rawDir: rawDirForCanonicalDir(canonicalDir), indexPath: join(root, "index.db") };
}

test("a session restored into an empty store reparses from the version that arrived last", async () => {
  const live = store("restore-order-live-");
  storeRawCapture(live.rawDir, version("firstneedle", "2026-06-05T10:00:00.000Z"));
  storeRawCapture(live.rawDir, version("secondneedle", "2026-06-05T11:00:00.000Z"));
  // Arrival order, not fetched_at order, is what ingest records as latest.
  const last = storeRawCapture(live.rawDir, version("lastneedle", "2026-06-05T09:00:00.000Z"));
  const target = new OrderedTarget(new LocalDirTarget(makeTmp("restore-order-target-")));
  const { snapshot } = await createBackup({ canonicalDir: live.canonicalDir, target });

  const restored = store("restore-order-empty-");
  await restoreBackup({ canonicalDir: restored.canonicalDir, target, snapshot });
  expect(listRawCaptures(restored.rawDir, "chatgpt", "conv-1")).toHaveLength(3);
  expect(latestRawReference(restored.rawDir, "chatgpt", "conv-1")).toBe(last);
  expect(latestRaw(join(restored.rawDir, "chatgpt", "conv-1"))?.file).toBe(basename(last));
  await reparse({ canonicalDir: restored.canonicalDir, indexPath: restored.indexPath });
  expect(readSession(restored.canonicalDir, "chatgpt", "conv-1").messages[0].text).toBe("lastneedle");
}, 30000);

test("restore keeps a valid local marker and never writes one for a tombstoned session", async () => {
  const live = store("restore-marker-keep-");
  const older = storeRawCapture(live.rawDir, version("older", "2026-06-05T10:00:00.000Z"));
  storeRawCapture(live.rawDir, version("newer", "2026-06-05T11:00:00.000Z"));
  const target = new LocalDirTarget(makeTmp("restore-marker-keep-target-"));
  const { snapshot } = await createBackup({ canonicalDir: live.canonicalDir, target });
  // The local store's own ingest chose another version after the snapshot.
  const marker = join(live.rawDir, "chatgpt", "conv-1", "latest.json");
  const local = JSON.parse(readFileSync(marker, "utf8"));
  local.file = basename(older);
  await Bun.write(marker, JSON.stringify(local));
  await restoreBackup({ canonicalDir: live.canonicalDir, target, snapshot, force: true });
  expect(JSON.parse(readFileSync(marker, "utf8")).file).toBe(basename(older));

  const { markSessionDeleted } = await import("../src/store/tombstones");
  const restored = store("restore-marker-deleted-");
  markSessionDeleted(restored.canonicalDir, { source: "chatgpt", source_id: "conv-1", deleted_at: "2026-10-13T00:00:00Z" });
  await restoreBackup({ canonicalDir: restored.canonicalDir, target, snapshot, force: true });
  expect(existsSync(join(restored.rawDir, "chatgpt", "conv-1"))).toBe(false);
}, 30000);

test("without a marker, the newest version is chosen by fetched_at, not by restore mtime", async () => {
  const live = store("restore-order-legacy-");
  storeRawCapture(live.rawDir, version("firstneedle", "2026-06-05T10:00:00.000Z"));
  const newest = storeRawCapture(live.rawDir, version("newestneedle", "2026-06-05T12:00:00.000Z"));
  storeRawCapture(live.rawDir, version("middleneedle", "2026-06-05T11:00:00.000Z"));
  const inner = new LocalDirTarget(makeTmp("restore-order-legacy-target-"));
  const target = new OrderedTarget(inner, true);
  const { snapshot } = await createBackup({ canonicalDir: live.canonicalDir, target });
  // A snapshot made before markers were backed up.
  for (const file of inner.listFiles(snapshot).filter(file => file.endsWith("/latest.json"))) unlinkSync(join(inner["baseDir"], snapshot, file));

  const restored = store("restore-order-legacy-empty-");
  await restoreBackup({ canonicalDir: restored.canonicalDir, target, snapshot });
  const dir = join(restored.rawDir, "chatgpt", "conv-1");
  expect(existsSync(join(dir, "latest.json"))).toBe(false);
  expect(latestRawReference(restored.rawDir, "chatgpt", "conv-1")).toBe(newest);
  expect(latestRaw(dir)?.file).toBe(basename(newest));
});

test("without a marker, an enriched version outranks the capture it was derived from", () => {
  const { rawDir } = store("restore-order-derived-");
  const fetchedAt = "2026-06-05T10:00:00.000Z";
  const asset = (pointer: string) => ({ pointer, local_path: `assets/blobs/${pointer}`, message_id: null, sha256: "a".repeat(64) });
  // Gemini retention re-archives the incoming capture with earlier media, under the same fetched_at.
  const previous = buildRawCapture({ source: "gemini", sourceId: "g1", endpoint: "/detail", payload: { p: 1 }, fetchedAt: "2026-06-05T09:00:00.000Z", assets: [asset("old")] });
  storeRawCapture(rawDir, previous);
  const incoming = buildRawCapture({ source: "gemini", sourceId: "g1", endpoint: "/detail", payload: { p: 1 }, fetchedAt });
  const { rawRef: merged } = archiveCaptureWithGeminiMedia(rawDir, incoming, JSON.stringify(incoming));
  // Asset backfill re-archives the latest capture with linked assets, also under its fetched_at.
  const chat = buildRawCapture({ source: "chatgpt", sourceId: "c1", endpoint: "/detail", payload: { p: 1 }, fetchedAt, assets: [asset("one")] });
  storeRawCapture(rawDir, chat);
  const enriched = storeRawCapture(rawDir, { ...chat, assets: [asset("two")], asset_backfilled_at: "2026-06-06T00:00:00.000Z" });

  for (const [source, id, latest] of [["gemini", "g1", merged], ["chatgpt", "c1", enriched]] as const) {
    const dir = join(rawDir, source, id);
    unlinkSync(join(dir, "latest.json"));
    // Restored in the wrong order: the derived version has the oldest mtime.
    const refs = listRawCaptures(rawDir, source, id);
    refs.forEach((ref, index) => {
      const time = new Date(Date.UTC(2026, 0, 1) + (ref === latest ? 0 : (index + 1) * 60_000));
      utimesSync(join(rawDir, ref), time, time);
    });
    expect(latestRawReference(rawDir, source, id)).toBe(latest);
    expect(latestRaw(dir)?.file).toBe(basename(latest));
  }
});
