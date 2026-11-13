// POST /status must not write monitor rows back for a session that was deleted.
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { handleIngestRequest } from "../packages/ingest/src/server";
import { deleteSessionEverywhere } from "../src/core/delete-session";
import { openIndex } from "../src/indexer/sqlite";
import { readMonitorState } from "../src/monitor/state";
import { markSessionDeleted } from "../src/store/tombstones";
const sample = (await import("./fixtures/chatgpt-api-sample.json")).default;

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "status-deleted-")); roots.push(root);
  const indexPath = join(root, "index.db");
  return { root, indexPath, canonicalDir: join(root, "canonical", "sessions"), rawDir: join(root, "raw"), statePath: `${indexPath}.monitor.sqlite` };
}
type Ctx = ReturnType<typeof setup>;
const capture = (sourceId: string) => {
  const value = structuredClone(sample) as any;
  value.source_id = sourceId;
  value.payload.conversation_id = sourceId;
  return value;
};
const failure = (sourceId: string, pointer: string | null, extra: Record<string, unknown> = {}) => ({ source_id: sourceId, message_id: "m1", reason: "asset_expired", ...(pointer ? { pointer } : {}), ...extra });
const status = async (c: Ctx, failures: unknown[]) => (await handleIngestRequest(new Request("http://local/status", {
  method: "POST", body: JSON.stringify({ source: "chatgpt", conversations: [], asset_failures: failures }) }), c)).json() as Promise<any>;
function outcomes(c: Ctx): Array<{ source_id: string; pointer: string }> {
  const db = new Database(c.statePath, { readonly: true });
  try { return db.query("SELECT source_id, pointer FROM asset_outcomes ORDER BY source_id").all() as any; } finally { db.close(); }
}
/** One live and one captured-then-deleted session, as DELETE /captures leaves them. */
async function seed(c: Ctx) {
  for (const id of ["live", "gone"]) await handleIngestRequest(new Request("http://local/captures", { method: "POST", body: JSON.stringify(capture(id)) }), c);
  const db = openIndex(c.indexPath);
  try { deleteSessionEverywhere({ canonicalDir: c.canonicalDir, rawDir: c.rawDir, monitorStatePath: c.statePath }, db, "chatgpt", "gone"); } finally { db.close(); }
}

test("a status report after deletion does not write asset outcomes for the deleted session", async () => {
  const c = setup();
  const logs = spyOn(console, "error").mockImplementation(() => {});
  try {
    await seed(c);
    const answer = await status(c, [failure("gone", "https://example.com/a?token=secret")]);
    expect(answer).toMatchObject({ ok: true });
    expect(outcomes(c)).toEqual([]);
  } finally { logs.mockRestore(); }
});

test("other sessions in the same report are recorded and counted; deleted ones are neither", async () => {
  const c = setup();
  const logs = spyOn(console, "error").mockImplementation(() => {});
  try {
    await seed(c);
    const answer = await status(c, [failure("gone", "file-1"), failure("live", "file-2"), failure("gone", "file-3")]);
    expect(answer).toMatchObject({ ok: true, asset_failures: 3 });
    expect(outcomes(c)).toEqual([{ source_id: "live", pointer: "file-2" }]);
    expect(readMonitorState(c.statePath).counters.asset_failures).toBe(1);
    expect(readMonitorState(c.statePath).recentAssetReports).toBe(1);
  } finally { logs.mockRestore(); }
});

test("a deleted session's pointers are answered as ignored so the extension stops retrying", async () => {
  const c = setup();
  const logs = spyOn(console, "error").mockImplementation(() => {});
  try {
    await seed(c);
    const answer = await status(c, [failure("gone", "file-1"), failure("live", "file-2"), failure("gone", null)]);
    expect(answer.ignored_assets).toEqual(["file-1"]);
    expect(outcomes(c)).toEqual([{ source_id: "live", pointer: "file-2" }]);
  } finally { logs.mockRestore(); }
});

test("a report for a session that was never deleted is unchanged", async () => {
  const c = setup();
  const logs = spyOn(console, "error").mockImplementation(() => {});
  try {
    const answer = await status(c, [failure("live", "file-2")]);
    expect(answer).toMatchObject({ ok: true, asset_failures: 1, ignored_assets: [] });
    expect(outcomes(c)).toEqual([{ source_id: "live", pointer: "file-2" }]);
  } finally { logs.mockRestore(); }
});

test("a tombstone that lands while the report is recorded erases the rows it wrote", async () => {
  const c = setup();
  const logs = spyOn(console, "error").mockImplementation(() => {});
  try {
    await handleIngestRequest(new Request("http://local/captures", { method: "POST", body: JSON.stringify(capture("racy")) }), c);
    // The CLI deletes in another process: the tombstone appears after ingest's first check, before its write.
    const original = Database.prototype.transaction;
    let fired = false;
    const spy = spyOn(Database.prototype, "transaction").mockImplementation(function (this: Database, fn: any) {
      if (!fired && this.filename === c.statePath) { fired = true; markSessionDeleted(c.canonicalDir, { source: "chatgpt", source_id: "racy", deleted_at: new Date().toISOString() }); }
      return original.call(this, fn);
    } as any);
    try { await status(c, [failure("racy", "file-1")]); } finally { spy.mockRestore(); }
    expect(fired).toBe(true);
    expect(outcomes(c)).toEqual([]);
  } finally { logs.mockRestore(); }
});
