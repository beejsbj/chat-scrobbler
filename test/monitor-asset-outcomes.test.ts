import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { handleIngestRequest } from "../packages/ingest/src/server";
import { liveMonitorReport } from "../src/monitor/live-report";
import { monitorReport } from "../src/monitor/report";
import { readMonitorState, recordAssetFailureOutcomes } from "../src/monitor/state";
import { openIndex } from "../src/indexer/sqlite";
import { reportablePointer } from "../packages/extension/src/providers/asset-outcomes";

function setup() {
  const root = mkdtempSync(join(import.meta.dir, ".monitor-assets-"));
  const opts = { canonicalDir: join(root, "canonical", "sessions"), indexPath: join(root, "index.db"), ingestToken: null };
  openIndex(opts.indexPath).close();
  return { root, opts, statePath: `${opts.indexPath}.monitor.sqlite` };
}
const report = (opts: any, source: string, failures: unknown[]) => handleIngestRequest(new Request("http://local/status", {
  method: "POST", body: JSON.stringify({ source, conversations: [], asset_failures: failures }) }), opts);
const assetLines = (lines: string[]) => lines.filter(line => line.startsWith("FAILED assets"));

test("one asset failing on every pass counts once in the window, while attempts stay visible", async () => {
  const { root, opts } = setup();
  const logs = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (let pass = 0; pass < 5; pass++) expect((await report(opts, "gemini", [{ source_id: "g1", message_id: "r1", reason: "asset_upload_failed", pointer: "https://lh3.googleusercontent.com/x" }])).status).toBe(200);
    const full = await monitorReport(opts);
    expect(full.assets).toMatchObject({ upload_failures: 5, recent_failure_reports: 5, recent_upload_failures: 1, recent_unavailable: 0 });
    expect(assetLines(full.failures)).toEqual(["FAILED assets recent_upload_failures=1"]);
    const live = liveMonitorReport(opts);
    expect(live.assets).toMatchObject({ recent_failure_reports: 5, recent_upload_failures: 1 });
    expect(assetLines(live.failures)).toEqual(["FAILED assets recent_upload_failures=1"]);
    expect(JSON.stringify([full, live])).not.toContain("googleusercontent");
  } finally { logs.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

test("terminal outcomes are recorded per asset but never raise a FAILED line", async () => {
  const { root, opts } = setup();
  const logs = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (let pass = 0; pass < 3; pass++) await report(opts, "chatgpt", [{ source_id: "c1", message_id: "m1", reason: "asset_expired", pointer: "file-service://file-1" }]);
    await report(opts, "gemini", [{ source_id: "g1", message_id: "r1", reason: "asset_url_unavailable", pointer: "opaque" }, { source_id: "g1", message_id: "r2", reason: "asset_url_unavailable", pointer: "opaque" }]);
    const full = await monitorReport(opts);
    expect(full.assets).toMatchObject({ recent_upload_failures: 0, recent_unavailable: 3, recent_failure_reports: 5,
      recent_failures_by_reason: { asset_expired: 1, asset_url_unavailable: 2 } });
    expect(assetLines(full.failures)).toEqual([]);
    expect(assetLines(liveMonitorReport(opts).failures)).toEqual([]);
    expect(JSON.stringify(logs.mock.calls)).toContain("asset_capture_failed");
    expect(JSON.stringify(logs.mock.calls)).not.toContain("file-service://file-1");
  } finally { logs.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

test("a later successful upload or reference clears the asset's failure record", async () => {
  const { root, opts } = setup();
  const logs = spyOn(console, "error").mockImplementation(() => {});
  try {
    await report(opts, "claude", [{ source_id: "cl1", message_id: "m1", reason: "asset_upload_failed", pointer: "att-1" }, { source_id: "cl1", message_id: "m2", reason: "asset_download_failed", pointer: "att-2" }]);
    expect((await monitorReport(opts)).assets.recent_upload_failures).toBe(2);
    const upload = await handleIngestRequest(new Request("http://local/assets?source=claude&source_id=cl1&pointer=att-1&message_id=m1", {
      method: "POST", headers: { "content-type": "image/png" }, body: new Uint8Array([137, 80, 78, 71]) }), opts);
    expect(upload.status).toBe(200);
    const { sha256 } = await upload.json();
    expect((await monitorReport(opts)).assets.recent_upload_failures).toBe(1);
    const reference = await handleIngestRequest(new Request(`http://local/assets/reference?sha256=${sha256}&source=claude&source_id=cl1&pointer=att-2&message_id=m2`, { method: "POST" }), opts);
    expect(reference.status).toBe(200);
    expect((await monitorReport(opts)).assets.recent_upload_failures).toBe(0);
  } finally { logs.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

test("reports without a pointer still collapse per message, and the record keeps identity without bytes", async () => {
  const { root, opts, statePath } = setup();
  const logs = spyOn(console, "error").mockImplementation(() => {});
  try {
    await report(opts, "chatgpt", [{ source_id: "c1", message_id: "m1", reason: "asset_download_failed" }, { source_id: "c1", message_id: "m1", reason: "asset_download_failed" }, { source_id: "c1", message_id: null, reason: "asset_download_failed" }]);
    const state = readMonitorState(statePath);
    expect(state.assetOutcomes).toMatchObject({ transient: 2, terminal: 0 });
    expect(state.recentAssetReports).toBe(3);
    const db = new Database(statePath, { readonly: true });
    try {
      const rows = db.query("SELECT source, source_id, message_id, pointer, reason, attempts FROM asset_outcomes ORDER BY message_id").all();
      expect(rows).toEqual([
        { source: "chatgpt", source_id: "c1", message_id: "", pointer: "", reason: "asset_download_failed", attempts: 1 },
        { source: "chatgpt", source_id: "c1", message_id: "m1", pointer: "", reason: "asset_download_failed", attempts: 2 },
      ]);
    } finally { db.close(); }
    const rejected = await report(opts, "chatgpt", [{ source_id: "c1", message_id: "m1", reason: "asset_download_failed", pointer: "x".repeat(2000) }]);
    expect(rejected.status).toBe(400);
  } finally { logs.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

test("an old failure outside the window no longer counts, and a repeat brings it back", () => {
  const { root, statePath } = setup();
  try {
    const dayMs = 24 * 3_600_000;
    const now = Date.now();
    recordAssetFailureOutcomes(statePath, "gemini", [{ source_id: "g1", message_id: "r1", reason: "asset_upload_failed", pointer: "p" }], now - 3 * dayMs);
    expect(readMonitorState(statePath, now - 2 * dayMs).assetOutcomes.transient).toBe(0);
    recordAssetFailureOutcomes(statePath, "gemini", [{ source_id: "g1", message_id: "r1", reason: "asset_upload_failed", pointer: "p" }], now);
    const state = readMonitorState(statePath, now - 2 * dayMs);
    expect(state.assetOutcomes.transient).toBe(1);
    expect(state.counters.asset_failures).toBe(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a successful upload clears a long pointer that was reported in its sha256 form", async () => {
  const { root, opts } = setup();
  const logs = spyOn(console, "error").mockImplementation(() => {});
  try {
    const pointer = `https://lh3.googleusercontent.com/gg-dl/${"a".repeat(600)}`;
    const digested = await reportablePointer(pointer);
    expect(digested.startsWith("sha256:")).toBe(true);
    await report(opts, "gemini", [{ source_id: "g1", message_id: "r1", reason: "asset_upload_failed", pointer: digested }]);
    expect((await monitorReport(opts)).assets.recent_upload_failures).toBe(1);
    const upload = await handleIngestRequest(new Request(`http://local/assets?source=gemini&source_id=g1&message_id=r1&pointer=${encodeURIComponent(pointer)}`, {
      method: "POST", headers: { "content-type": "image/png" }, body: new Uint8Array([137, 80, 78, 71]) }), opts);
    expect(upload.status).toBe(200);
    expect((await monitorReport(opts)).assets.recent_upload_failures).toBe(0);
  } finally { logs.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

test("deleting a session erases its asset outcome records", async () => {
  const { root, opts, statePath } = setup();
  const logs = spyOn(console, "error").mockImplementation(() => {});
  try {
    await report(opts, "chatgpt", [{ source_id: "c1", message_id: "m1", reason: "asset_upload_failed", pointer: "file-a" }]);
    await report(opts, "chatgpt", [{ source_id: "c2", message_id: "m1", reason: "asset_expired", pointer: "file-b" }]);
    const deleted = await handleIngestRequest(new Request("http://local/captures?source=chatgpt&source_id=c1", { method: "DELETE" }), opts);
    expect(deleted.status).toBe(200);
    const db = new Database(statePath, { readonly: true });
    try {
      expect(db.query("SELECT source_id FROM asset_outcomes ORDER BY source_id").all()).toEqual([{ source_id: "c2" }]);
    } finally { db.close(); }
  } finally { logs.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});
