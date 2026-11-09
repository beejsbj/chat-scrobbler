import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { handleIngestRequest } from "../packages/ingest/src/server";
import { runAssetsCmd } from "../src/cli/assets";
import { monitorReport } from "../src/monitor/report";
import { liveMonitorReport } from "../src/monitor/live-report";
import { readMonitorState } from "../src/monitor/state";
import { openIndex } from "../src/indexer/sqlite";
import { writeSession } from "../src/store/sessions";
import type { Session } from "../src/schema/types";

function setup() {
  const root = mkdtempSync(join(import.meta.dir, ".asset-ignore-"));
  const cfg = { canonicalDir: join(root, "canonical", "sessions"), indexPath: join(root, "index.db"), monitorStatePath: null as string | null };
  openIndex(cfg.indexPath).close();
  return { root, cfg, opts: { ...cfg, ingestToken: null }, statePath: `${cfg.indexPath}.monitor.sqlite` };
}
type Ctx = ReturnType<typeof setup>;
const report = async (c: Ctx, source: string, failures: unknown[]) => (await handleIngestRequest(new Request("http://local/status", {
  method: "POST", body: JSON.stringify({ source, conversations: [], asset_failures: failures }) }), c.opts)).json() as Promise<any>;
const failure = (pointer: string, extra: Record<string, unknown> = {}) => ({ source_id: "c1", message_id: "m1", reason: "asset_expired", pointer, ...extra });
async function cli(c: Ctx, ...args: string[]) {
  const lines: string[] = [];
  const code = await runAssetsCmd(c.cfg, args, line => lines.push(line));
  return { code, lines };
}
const idOf = (lines: string[], pointer: string) => lines.find(line => line.includes(pointer))!.split(/\s+/)[0];
const quiet = () => spyOn(console, "error").mockImplementation(() => {});

test("assets failing lists each failing asset once with a short id, reason, attempts and session", async () => {
  const c = setup();
  const logs = quiet();
  try {
    for (let i = 0; i < 3; i++) await report(c, "chatgpt", [failure("file-service://file-1")]);
    await report(c, "gemini", [failure("https://lh3.googleusercontent.com/x", { reason: "asset_download_failed", source_id: "g1" })]);
    const { code, lines } = await cli(c, "failing");
    expect(code).toBe(0);
    expect(lines).toHaveLength(2);
    expect(lines.find(l => l.includes("file-1"))).toMatch(/^[a-f0-9]{12} chatgpt asset_expired attempts=3 .*session=c1 message=m1 pointer=file-service:\/\/file-1/);
    const json = await cli(c, "failing", "--json");
    expect(JSON.parse(json.lines.join("\n"))).toMatchObject([{ id: expect.stringMatching(/^[a-f0-9]{12}$/) }, { id: expect.stringMatching(/^[a-f0-9]{12}$/) }]);
  } finally { logs.mockRestore(); rmSync(c.root, { recursive: true, force: true }); }
});

test("an ignored asset is answered as ignored, no longer counted, and leaves the failing list", async () => {
  const c = setup();
  const logs = quiet();
  try {
    await report(c, "chatgpt", [failure("file-1"), failure("file-2", { reason: "asset_upload_failed" })]);
    expect((await monitorReport(c.opts)).assets).toMatchObject({ recent_upload_failures: 1, recent_unavailable: 1, ignored: 0 });
    const id = idOf((await cli(c, "failing")).lines, "file-2");
    const ignored = await cli(c, "ignore", id);
    expect(ignored).toMatchObject({ code: 0 });
    expect(ignored.lines.join("\n")).toContain("ignored");
    expect((await cli(c, "failing")).lines.some(l => l.includes("file-2"))).toBe(false);
    const before = readMonitorState(c.statePath).counters.asset_failures;
    const answer = await report(c, "chatgpt", [failure("file-2", { reason: "asset_upload_failed" }), failure("file-1")]);
    expect(answer).toMatchObject({ ok: true, asset_failures: 2, ignored_assets: ["file-2"] });
    // Neither the report counter nor the per-asset record moved for the ignored asset.
    expect(readMonitorState(c.statePath).counters.asset_failures).toBe(before + 1);
    const full = await monitorReport(c.opts);
    expect(full.assets).toMatchObject({ recent_upload_failures: 0, recent_unavailable: 1, ignored: 1 });
    expect(full.failures.filter(line => line.startsWith("FAILED assets"))).toEqual([]);
    expect(liveMonitorReport(c.opts).assets).toMatchObject({ recent_upload_failures: 0, ignored: 1 });
    expect((await cli(c, "ignored")).lines.join("\n")).toContain("file-2");
  } finally { logs.mockRestore(); rmSync(c.root, { recursive: true, force: true }); }
});

test("ignoring is idempotent, rejects unknown ids, and unignore makes the asset count again", async () => {
  const c = setup();
  const logs = quiet();
  try {
    await report(c, "claude", [failure("att-1", { reason: "asset_upload_failed" })]);
    const id = idOf((await cli(c, "failing")).lines, "att-1");
    await cli(c, "ignore", id);
    expect((await cli(c, "ignore", id)).lines.join("\n")).toContain("already ignored");
    const unknown = await cli(c, "ignore", "deadbeef0000");
    expect(unknown.code).toBe(1);
    expect(unknown.lines.join("\n")).toContain("no failing asset");
    expect((await cli(c, "unignore", id)).code).toBe(0);
    expect((await cli(c, "unignore", id)).code).toBe(1);
    expect(await report(c, "claude", [failure("att-1", { reason: "asset_upload_failed" })])).toMatchObject({ ignored_assets: [] });
    expect((await monitorReport(c.opts)).assets).toMatchObject({ recent_upload_failures: 1, ignored: 0 });
  } finally { logs.mockRestore(); rmSync(c.root, { recursive: true, force: true }); }
});

test("a failure with no pointer cannot be ignored, because it would match every pointer-less failure of the message", async () => {
  const c = setup();
  const logs = quiet();
  try {
    await report(c, "chatgpt", [{ source_id: "c1", message_id: "m1", reason: "asset_download_failed" }]);
    const { lines } = await cli(c, "failing");
    expect(lines).toHaveLength(1);
    const refused = await cli(c, "ignore", lines[0].split(/\s+/)[0]);
    expect(refused.code).toBe(1);
    expect(refused.lines.join("\n")).toContain("no pointer");
  } finally { logs.mockRestore(); rmSync(c.root, { recursive: true, force: true }); }
});

test("a long pointer is ignored through the sha256 form the extension reports", async () => {
  const c = setup();
  const logs = quiet();
  try {
    const digest = `sha256:${"ab".repeat(32)}`;
    await report(c, "gemini", [failure(digest, { source_id: "g1" })]);
    await cli(c, "ignore", idOf((await cli(c, "failing")).lines, digest));
    expect(await report(c, "gemini", [failure(digest, { source_id: "g1" })])).toMatchObject({ ignored_assets: [digest] });
  } finally { logs.mockRestore(); rmSync(c.root, { recursive: true, force: true }); }
});

test("ignores survive the asset later being stored and are keyed per message", async () => {
  const c = setup();
  const logs = quiet();
  try {
    await report(c, "chatgpt", [failure("file-1")]);
    await cli(c, "ignore", idOf((await cli(c, "failing")).lines, "file-1"));
    expect(await report(c, "chatgpt", [failure("file-1", { message_id: "m2" })])).toMatchObject({ ignored_assets: [] });
    expect(readMonitorState(c.statePath).assetOutcomes.byReason).toEqual({ asset_expired: 1 });
    const db = new Database(c.statePath, { readonly: true });
    try { expect(db.query("SELECT count(*) AS n FROM asset_ignores").get()).toEqual({ n: 1 }); } finally { db.close(); }
  } finally { logs.mockRestore(); rmSync(c.root, { recursive: true, force: true }); }
});

test("reports from an older extension keep working: same request, same ok and count fields", async () => {
  const c = setup();
  const logs = quiet();
  try {
    const answer = await report(c, "chatgpt", [failure("file-1")]);
    expect(answer).toMatchObject({ ok: true, statuses: {}, asset_failures: 1, ignored_assets: [] });
    expect(await (await handleIngestRequest(new Request("http://local/status", { method: "POST", body: JSON.stringify({ source: "chatgpt", conversations: [] }) }), c.opts)).json()).not.toHaveProperty("ignored_assets");
  } finally { logs.mockRestore(); rmSync(c.root, { recursive: true, force: true }); }
});

test("backfill pages leave out ignored assets, and offer them again after unignore", async () => {
  const c = setup();
  const logs = quiet();
  try {
    const long = `https://lh3.googleusercontent.com/${"a".repeat(600)}`;
    const session: Session = {
      id: "gemini:g1", source: "gemini", source_id: "g1", capture_method: "api", title: "t", created_at: null, updated_at: null, default_model: null, account: null,
      messages: [{ id: "r1", role: "assistant", created_at: null, parent_id: null, model: null, text: "", blocks: [
        { type: "image", pointer: "kept", filename: null, local_path: null, sha256: null, mime_type: null },
        { type: "image", pointer: "skipped", filename: null, local_path: null, sha256: null, mime_type: null },
        { type: "image", pointer: long, filename: null, local_path: null, sha256: null, mime_type: null },
      ] as any }],
      active_leaf_id: "r1", raw_ref: "raw/api/x", schema_version: 2,
    } as unknown as Session;
    writeSession(c.cfg.canonicalDir, session);
    const { createHash } = await import("node:crypto");
    const digest = `sha256:${createHash("sha256").update(long).digest("hex")}`;
    await report(c, "gemini", [failure("skipped", { source_id: "g1", message_id: "r1" }), failure(digest, { source_id: "g1", message_id: "r1" })]);
    for (const pointer of ["skipped", digest]) await cli(c, "ignore", idOf((await cli(c, "failing")).lines, pointer));
    const page = async () => (await (await handleIngestRequest(new Request("http://local/assets/backfill?source=gemini"), c.opts)).json() as any).sessions[0].references.map((r: any) => r.pointer);
    expect(await page()).toEqual(["kept"]);
    await cli(c, "unignore", idOf((await cli(c, "ignored")).lines, "skipped"));
    expect(await page()).toEqual(["kept", "skipped"]);
  } finally { logs.mockRestore(); rmSync(c.root, { recursive: true, force: true }); }
});

test("assets command rejects unknown subcommands and missing ids with usage", async () => {
  const c = setup();
  try {
    expect((await cli(c, "bogus")).code).toBe(1);
    const missing = await cli(c, "ignore");
    expect(missing.code).toBe(1);
    expect(missing.lines.join("\n")).toContain("usage");
    expect((await cli(c, "failing")).lines).toEqual(["no failing assets"]);
  } finally { rmSync(c.root, { recursive: true, force: true }); }
});
