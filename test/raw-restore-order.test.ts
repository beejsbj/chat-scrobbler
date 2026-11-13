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
  storeRawCapture(live.rawDir, version("older", "2026-06-05T10:00:00.000Z"));
  storeRawCapture(live.rawDir, version("newer", "2026-06-05T11:00:00.000Z"));
  const target = new LocalDirTarget(makeTmp("restore-marker-keep-target-"));
  const { snapshot } = await createBackup({ canonicalDir: live.canonicalDir, target });
  // The local store's own ingest received a version after the snapshot.
  const later = storeRawCapture(live.rawDir, version("later", "2026-06-05T09:00:00.000Z"));
  const marker = join(live.rawDir, "chatgpt", "conv-1", "latest.json");
  await restoreBackup({ canonicalDir: live.canonicalDir, target, snapshot, force: true });
  expect(JSON.parse(readFileSync(marker, "utf8")).file).toBe(basename(later));

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

test("a marker ingest writes while restore downloads the snapshot's marker is kept", async () => {
  const live = store("restore-marker-race-");
  storeRawCapture(live.rawDir, version("first", "2026-06-05T10:00:00.000Z"));
  storeRawCapture(live.rawDir, version("second", "2026-06-05T11:00:00.000Z"));
  const inner = new LocalDirTarget(makeTmp("restore-marker-race-target-"));
  const { snapshot } = await createBackup({ canonicalDir: live.canonicalDir, target: inner });
  const restored = store("restore-marker-race-empty-");
  let ingested = "";
  const target = new OrderedTarget(inner);
  const getFile = target.getFile.bind(target);
  target.getFile = async (snap, relPath, dest) => {
    if (relPath.endsWith("/latest.json")) ingested = storeRawCapture(restored.rawDir, version("ingested", "2026-06-05T12:00:00.000Z"));
    return getFile(snap, relPath, dest);
  };
  await restoreBackup({ canonicalDir: restored.canonicalDir, target, snapshot });
  expect(latestRawReference(restored.rawDir, "chatgpt", "conv-1")).toBe(ingested);
}, 30000);

test("a forced restore of a newer snapshot replaces the marker of a stale copy of the store", async () => {
  const live = store("restore-stale-live-");
  storeRawCapture(live.rawDir, version("first", "2026-06-05T10:00:00.000Z"));
  storeRawCapture(live.rawDir, version("second", "2026-06-05T11:00:00.000Z"));
  const target = new LocalDirTarget(makeTmp("restore-stale-target-"));
  const { snapshot: old } = await createBackup({ canonicalDir: live.canonicalDir, target, snapshotName: "old" });
  const stale = store("restore-stale-copy-");
  await restoreBackup({ canonicalDir: stale.canonicalDir, target, snapshot: old });
  // Arrived last on the live store only, with an older fetched_at.
  const third = storeRawCapture(live.rawDir, version("third", "2026-06-05T09:00:00.000Z"));
  const { snapshot } = await createBackup({ canonicalDir: live.canonicalDir, target, snapshotName: "new" });
  await restoreBackup({ canonicalDir: stale.canonicalDir, target, snapshot, force: true });
  expect(latestRawReference(stale.rawDir, "chatgpt", "conv-1")).toBe(third);
}, 30000);

test("an unreadable version tied on fetched_at ranks lowest instead of blocking ingest", () => {
  const { rawDir } = store("restore-order-corrupt-");
  const chat = buildRawCapture({ source: "chatgpt", sourceId: "c1", endpoint: "/detail", payload: { p: 1 }, fetchedAt: "2026-06-05T10:00:00.000Z" });
  const source = storeRawCapture(rawDir, chat);
  const enriched = storeRawCapture(rawDir, { ...chat, assets: [{ pointer: "p", local_path: "assets/blobs/p", sha256: "a".repeat(64) }], asset_backfilled_at: "2026-06-06T00:00:00.000Z" });
  expect(enriched).not.toBe(source);
  const dir = join(rawDir, "chatgpt", "c1");
  unlinkSync(join(dir, "latest.json"));
  require("node:fs").writeFileSync(join(rawDir, source), "truncated");
  expect(latestRawReference(rawDir, "chatgpt", "c1")).toBe(enriched);
  expect(() => storeRawCapture(rawDir, { ...chat, fetched_at: "2026-06-07T00:00:00.000Z", payload: { p: 2 } })).not.toThrow();
});

test("rerunning a forced restore that failed after writing the versions still replaces a stale marker", async () => {
  const live = store("restore-rerun-live-");
  storeRawCapture(live.rawDir, version("first", "2026-06-05T10:00:00.000Z"));
  storeRawCapture(live.rawDir, version("second", "2026-06-05T11:00:00.000Z"));
  const inner = new LocalDirTarget(makeTmp("restore-rerun-target-"));
  const { snapshot: old } = await createBackup({ canonicalDir: live.canonicalDir, target: inner, snapshotName: "old" });
  const stale = store("restore-rerun-copy-");
  await restoreBackup({ canonicalDir: stale.canonicalDir, target: inner, snapshot: old });
  const third = storeRawCapture(live.rawDir, version("third", "2026-06-05T09:00:00.000Z"));
  const { snapshot } = await createBackup({ canonicalDir: live.canonicalDir, target: inner, snapshotName: "new" });
  const failing = new OrderedTarget(inner);
  failing.getFile = async (snap, relPath, dest) => {
    if (relPath.endsWith("/latest.json")) throw new Error("target offline");
    return inner.getFile(snap, relPath, dest);
  };
  await expect(restoreBackup({ canonicalDir: stale.canonicalDir, target: failing, snapshot, force: true })).rejects.toThrow("target offline");
  await restoreBackup({ canonicalDir: stale.canonicalDir, target: inner, snapshot, force: true });
  expect(latestRawReference(stale.rawDir, "chatgpt", "conv-1")).toBe(third);
}, 30000);
