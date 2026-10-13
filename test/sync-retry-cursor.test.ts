import { expect, test } from "bun:test";
import { createChatgptAdapter } from "../packages/extension/src/providers/chatgpt";
import { createClaudeAdapter } from "../packages/extension/src/providers/claude";

for (const source of ["chatgpt", "claude"] as const) test(`${source} advances cursor after three failures and retains a retry record`, async () => {
  let badCalls = 0;
  let changed = false;
  const adapter = (source === "chatgpt" ? createChatgptAdapter : createClaudeAdapter)(async input => {
    if (input === "/api/auth/session") return Response.json({});
    if (input === "/api/organizations") return Response.json([{ uuid: "org" }]);
    if (input.includes("conversations?")) {
      const bad = { id: "bad", uuid: "bad", update_time: changed ? "2026-06-06T12:00:00Z" : "2026-06-05T12:00:00Z", updated_at: changed ? "2026-06-06T12:00:00Z" : "2026-06-05T12:00:00Z" };
      const good = { id: "good", uuid: "good", update_time: "2026-06-05T11:00:00Z", updated_at: "2026-06-05T11:00:00Z" };
      return Response.json(source === "chatgpt" ? { items: [bad, good] } : [bad, good]);
    }
    if (input.includes("/bad")) { badCalls++; throw new Error("permanent provider failure"); }
    return Response.json({ mapping: {}, chat_messages: [] });
  });
  let captureFailures: any[] = [];
  let cursor: string | null = "2026-06-05T08:00:00Z";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await adapter.sync({ lastSync: cursor, captureFailures, emitCapture: async () => {} });
    captureFailures = result.captureFailures!;
    expect(captureFailures).toMatchObject([{ source_id: "bad", attempts: attempt, quarantined: attempt === 3 }]);
    cursor = result.maxConversationUpdatedAt;
    expect(cursor).toBe(attempt === 3 ? "2026-06-05T12:00:00Z" : "2026-06-05T08:00:00Z");
  }
  await adapter.sync({ lastSync: null, captureFailures, emitCapture: async () => {} });
  expect(badCalls).toBe(3);
  changed = true;
  const result = await adapter.sync({ lastSync: cursor, captureFailures, emitCapture: async () => {} });
  expect(badCalls).toBe(4);
  expect(result.captureFailures).toMatchObject([{ attempts: 1, quarantined: false }]);
});

test("status persists and reports the provider capture failure list", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { handleIngestRequest } = await import("../packages/ingest/src/server");
  const dir = mkdtempSync(join(tmpdir(), "scrobbler-retries-"));
  try {
    const opts = { canonicalDir: join(dir, "canonical/sessions"), indexPath: join(dir, "index/db.sqlite"), ingestToken: "receiver" };
    const failures = [{ source_id: "bad", updated_at: null, attempts: 3, quarantined: true }];
    const request = (body: unknown) => new Request("http://local/status", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer receiver" }, body: JSON.stringify(body) });
    expect((await handleIngestRequest(request({ source: "chatgpt", conversations: [], capture_failures: failures }), opts)).ok).toBe(true);
    const res = await handleIngestRequest(request({ source: "chatgpt", conversations: [] }), opts);
    expect(await res.json()).toMatchObject({ capture_failures: failures });
    expect((await handleIngestRequest(request({ source: "chatgpt", conversations: [], capture_failures: [{ ...failures[0], attempts: -1 }] }), opts)).status).toBe(400);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
