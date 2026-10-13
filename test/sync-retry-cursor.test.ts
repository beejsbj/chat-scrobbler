import { expect, test } from "bun:test";
import { createChatgptAdapter } from "../packages/extension/src/providers/chatgpt";
import { createClaudeAdapter } from "../packages/extension/src/providers/claude";
import { createGeminiAdapter } from "../packages/extension/src/providers/gemini";

test("Gemini propagates throttling without capturing a DOM substitute", async () => {
  let emitted = false;
  const adapter = createGeminiAdapter(async () => new Response("", { status: 429, headers: { "retry-after": "60" } }), {
    listConversationIds: () => ["c"], readWizData: () => ({ at: "csrf", bl: "b", fSid: "s" }), readConversationDom: () => "fallback",
  });
  await expect(adapter.sync({ emitCapture: async () => { emitted = true; } })).rejects.toMatchObject({ name: "RateLimitError" });
  expect(emitted).toBe(false);
});

for (const source of ["chatgpt", "claude"] as const) test(`${source} stops on provider throttling instead of quarantining conversations`, async () => {
  let detailCalls = 0;
  const adapter = (source === "chatgpt" ? createChatgptAdapter : createClaudeAdapter)(async input => {
    if (input === "/api/auth/session") return Response.json({});
    if (input === "/api/organizations") return Response.json([{ uuid: "org" }]);
    if (input.includes("conversations?")) {
      const items = ["a", "b"].map(id => ({ id, uuid: id, updated_at: "2026-06-05T12:00:00Z", update_time: "2026-06-05T12:00:00Z" }));
      return Response.json(source === "chatgpt" ? { items } : items);
    }
    detailCalls++;
    return new Response("", { status: 429, headers: { "retry-after": "60" } });
  });
  await expect(adapter.sync({ emitCapture: async () => {} })).rejects.toMatchObject({ name: "RateLimitError", retryAfterMs: 60_000 });
  expect(detailCalls).toBe(1);
});

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
    if (input.includes("/bad")) { badCalls++; return new Response("gone", { status: 404 }); }
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

test("Gemini automatically retries a timestamp-less quarantine after its cooldown", async () => {
  const { createGeminiAdapter } = await import("../packages/extension/src/providers/gemini");
  const payload = [[[["c_c", "r_user"], null, [["hello"]], null]]];
  let rpcCalls = 0;
  const adapter = createGeminiAdapter(async () => { rpcCalls++; return new Response(JSON.stringify([["wrb.fr", "hNvQHb", JSON.stringify(payload)]])); }, {
    readWizData: () => ({ at: "csrf", bl: "b", fSid: "s" }), listConversationIds: () => ["c"], readConversationDom: () => null,
  });
  const result = await adapter.sync({ captureFailures: [{ source_id: "c", updated_at: null, attempts: 3, quarantined: true, retry_after: "2000-01-01T00:00:00Z" }], emitCapture: async () => {} });
  expect(rpcCalls).toBe(1);
  expect(result.captureFailures).toEqual([]);
});

for (const source of ["chatgpt", "claude", "gemini"] as const) for (const mode of ["provider-network", "provider-500", "ingest-network", "ingest-500"] as const) {
  test(`${source}: ${mode} aborts sync without quarantining after repeated outages`, async () => {
    const { TransientSyncError } = await import("../packages/extension/src/providers/sync-errors");
    let details = 0;
    const fetcher = async (input: string) => {
      if (input === "/api/auth/session") return Response.json({});
      if (input === "/api/organizations") return Response.json([{ uuid: "org" }]);
      if (input.includes("conversations?")) {
        const rows = ["a", "b"].map(id => ({ id, uuid: id, update_time: "2026-06-05T12:00:00Z", updated_at: "2026-06-05T12:00:00Z" }));
        return Response.json(source === "chatgpt" ? { items: rows } : rows);
      }
      details++;
      if (mode === "provider-network") throw new TypeError("Failed to fetch");
      if (mode === "provider-500") return new Response("", { status: 500 });
      return source === "gemini" ? new Response(JSON.stringify([["wrb.fr", "hNvQHb", JSON.stringify([[]])]])) : Response.json({ mapping: {}, chat_messages: [] });
    };
    const adapter = source === "gemini" ? createGeminiAdapter(fetcher, {
      listConversationIds: () => ["a", "b"], readWizData: () => ({ at: "csrf", bl: "b", fSid: "s" }), readConversationDom: () => null,
    }) : (source === "chatgpt" ? createChatgptAdapter : createClaudeAdapter)(fetcher);
    for (let i = 0; i < 3; i++) await expect(adapter.sync({ captureFailures: [], emitCapture: async () => {
      throw new TransientSyncError(mode === "ingest-network" ? "Receiver offline" : "Receiver 500");
    } })).rejects.toBeInstanceOf(TransientSyncError);
    expect(details).toBe(3);
  });
}

test("quarantined conversations automatically retry with increasing backoff and keep their attempt history", async () => {
  const { SyncFailureTracker } = await import("../packages/extension/src/providers/sync-failures");
  const tracker = new SyncFailureTracker();
  const now = Date.now();
  for (let n = 0; n < 3; n++) tracker.failed("bad", "2026-06-05T12:00:00Z");
  expect(Date.parse(tracker.list()[0].retry_after!) - now).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000);
  const previous = tracker.list()[0];
  const due = new SyncFailureTracker([{ ...previous, retry_after: "2000-01-01T00:00:00Z" }]);
  expect(due.isQuarantined("bad", previous.updated_at)).toBe(false);
  due.failed("bad", previous.updated_at);
  expect(due.list()[0].attempts).toBe(4);
  expect(Date.parse(due.list()[0].retry_after!) - now).toBeGreaterThanOrEqual(3 * 24 * 60 * 60 * 1000);
});

for (const source of ["chatgpt", "claude"] as const) test(`${source} retries due quarantines even behind the cursor`, async () => {
  let details = 0;
  const stamp = "2026-06-05T12:00:00Z";
  const adapter = (source === "chatgpt" ? createChatgptAdapter : createClaudeAdapter)(async input => {
    if (input === "/api/auth/session") return Response.json({});
    if (input === "/api/organizations") return Response.json([{ uuid: "org" }]);
    if (input.includes("conversations?")) return Response.json(source === "chatgpt" ? { items: [{ id: "bad", update_time: stamp }] } : [{ uuid: "bad", updated_at: stamp }]);
    details++;
    return Response.json({ mapping: {}, chat_messages: [] });
  });
  const result = await adapter.sync({ lastSync: "2026-06-06T12:00:00Z", captureFailures: [{ source_id: "bad", attempts: 3, quarantined: true, updated_at: stamp, retry_after: "2000-01-01T00:00:00Z" }], emitCapture: async () => {} });
  expect(details).toBe(1);
  expect(result.captureFailures).toEqual([]);
});

for (const source of ["chatgpt", "claude", "gemini"] as const) for (const mode of ["gone", "ignored"] as const) test(`${source} drops ${mode} failure records so they cannot pin the cursor`, async () => {
  const stamp = "2026-06-05T12:00:00Z";
  const fetcher = async (input: string) => {
    if (input === "/api/auth/session") return Response.json({});
    if (input === "/api/organizations") return Response.json([{ uuid: "org" }]);
    if (input.includes("conversations?")) {
      const rows = (mode === "ignored" ? ["bad", "good"] : ["good"]).map(id => ({ id, uuid: id, update_time: stamp, updated_at: stamp }));
      return Response.json(source === "chatgpt" ? { items: rows } : rows);
    }
    return source === "gemini" ? new Response(JSON.stringify([["wrb.fr", "hNvQHb", JSON.stringify([[]])]])) : Response.json({ mapping: {}, chat_messages: [] });
  };
  const adapter = source === "gemini" ? createGeminiAdapter(fetcher, {
    listConversationIds: () => mode === "ignored" ? ["bad", "good"] : ["good"], readWizData: () => ({ at: "csrf", bl: "b", fSid: "s" }), readConversationDom: () => null,
  }) : (source === "chatgpt" ? createChatgptAdapter : createClaudeAdapter)(fetcher);
  const result = await adapter.sync({ lastSync: "2026-06-04T12:00:00Z", shouldIgnore: (_s, id) => id === "bad", captureFailures: [{ source_id: "bad", attempts: 1, quarantined: false, updated_at: source === "gemini" ? null : stamp }], emitCapture: async () => {} });
  expect(result.captureFailures).toEqual([]);
  expect(result.maxConversationUpdatedAt! > "2026-06-04T12:00:00Z").toBe(true);
});
