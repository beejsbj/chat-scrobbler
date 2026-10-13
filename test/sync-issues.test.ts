import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleIngestRequest } from "../packages/ingest/src/server";

async function withReceiver(run: (post: (body: unknown) => Promise<Response>) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "scrobbler-sync-issues-"));
  const options = { canonicalDir: join(root, "canonical/sessions"), indexPath: join(root, "index/db.sqlite"), ingestToken: "receiver" };
  try { await run(body => handleIngestRequest(new Request("http://receiver/status", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer receiver" }, body: JSON.stringify(body) }), options)); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test("/status durably exposes environmental receiver errors per installation without counting chat attempts", async () => {
  await withReceiver(async post => {
    const issue = { reason: "receiver_unavailable", status: 401, occurred_at: "2026-10-13T23:00:00Z" };
    expect((await post({ source: "chatgpt", install_id: "browser-a", conversations: [], capture_failures: [], last_sync_error: issue })).status).toBe(200);
    const result = await (await post({ source: "chatgpt", install_id: "browser-a", conversations: [] })).json();
    expect(result).toMatchObject({ capture_failures: [], sync_errors: [{ install_id: "browser-a", ...issue }] });
    expect(await (await post({ source: "chatgpt", install_id: "browser-b", conversations: [] })).json()).toMatchObject({ sync_errors: [] });
    await post({ source: "chatgpt", install_id: "browser-b", conversations: [], last_sync_error: { ...issue, status: 404 } });
    expect((await (await post({ source: "chatgpt", conversations: [] })).json()).sync_errors).toHaveLength(2);
    expect((await (await post({ source: "claude", conversations: [] })).json()).sync_errors).toEqual([]);
  });
});

for (const issue of [{ reason: "secret", occurred_at: "2026-10-13" }, { reason: "receiver_unavailable", status: -1, occurred_at: "2026-10-13" }, { reason: "receiver_unavailable", occurred_at: "invalid" }]) test("/status rejects malformed sync diagnostics", async () => {
  await withReceiver(async post => expect((await post({ source: "chatgpt", conversations: [], last_sync_error: issue })).status).toBe(400));
});
