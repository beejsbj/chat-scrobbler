import { expect, test } from "bun:test";
import { createChatgptAdapter } from "../packages/extension/src/providers/chatgpt";
import { createClaudeAdapter } from "../packages/extension/src/providers/claude";
import { syncErrorResponse } from "../packages/extension/src/sync-error-response";
import type { ConversationCaptureFailure } from "../packages/shared/src";

const stamp = "2026-06-05T12:00:00Z";
for (const source of ["chatgpt", "claude"] as const) for (const status of [401, 403]) {
  function adapter(expired: boolean) {
    let checked = false;
    return (source === "chatgpt" ? createChatgptAdapter : createClaudeAdapter)(async url => {
      if (url === "/api/auth/session" || url === "/api/organizations") {
        if (checked && expired) return Response.json(source === "chatgpt" ? {} : []);
        checked = true;
        return Response.json(source === "chatgpt" ? { accessToken: "same-session" } : [{ uuid: "org" }]);
      }
      if (url.includes("conversations?")) {
        const rows = ["bad", "good"].map(id => ({ id, uuid: id, update_time: stamp, updated_at: stamp }));
        return Response.json(source === "chatgpt" ? { items: rows } : rows);
      }
      return url.includes("/bad") ? new Response("unauthorized", { status }) : Response.json({ mapping: {}, chat_messages: [] });
    });
  }
  test(`${source} detail ${status} with an expired provider session aborts four runs with no attempts`, async () => {
    let captures = 0;
    for (let run = 0; run < 4; run++) {
      try { await adapter(true).sync({ emitCapture: async () => { captures++; } }); throw new Error("must abort"); }
      catch (error) {
        expect(error).toMatchObject({ name: "TransientSyncError", status });
        expect(syncErrorResponse(error).captureFailures).toEqual([]);
      }
    }
    expect(captures).toBe(0);
  });
  test(`${source} isolated detail ${status} with a valid session counts per chat and reaches the next chat`, async () => {
    let failures: ConversationCaptureFailure[] = [], captured = 0;
    for (let run = 0; run < 3; run++) {
      const result = await adapter(false).sync({ captureFailures: failures, emitCapture: async () => { captured++; } });
      failures = result.captureFailures!;
    }
    expect(failures).toMatchObject([{ source_id: "bad", attempts: 3, quarantined: true }]);
    expect(captured).toBe(3);
  });
}

for (const source of ["chatgpt", "claude"] as const) for (const status of [401, 403]) {
  test(`${source} manual retry with the provider session logged out (${status}) aborts on the first chat and touches no attempts`, async () => {
    const { retryCapturedFailures } = await import("../packages/extension/src/retry-captures");
    let detailCalls = 0;
    const adapter = (source === "chatgpt" ? createChatgptAdapter : createClaudeAdapter)(async url => {
      if (url === "/api/auth/session") return Response.json({});
      if (url === "/api/organizations") return new Response("unauthorized", { status });
      detailCalls++;
      return new Response("unauthorized", { status });
    });
    const records = ["a", "b", "c"].map(source_id => ({ source_id, attempts: 2, quarantined: false, updated_at: stamp, retry_after: "2000-01-01T00:00:00Z" }));
    const result = await retryCapturedFailures(adapter, { captureFailures: records, emitCapture: async () => {}, pause: async () => {} }).then(() => null, error => error);
    expect(result).toMatchObject({ name: "TransientSyncError" });
    expect(syncErrorResponse(result).captureFailures).toEqual(records);
    expect(records.every(r => r.attempts === 2)).toBe(true);
    expect(detailCalls).toBe(source === "chatgpt" ? 1 : 0);
  });
}

test("claude backfill and listing surface a logged-out organization request as transient", async () => {
  const adapter = createClaudeAdapter(async () => new Response("unauthorized", { status: 401 }));
  await expect(adapter.listConversations!(1)).rejects.toMatchObject({ name: "TransientSyncError", status: 401 });
  await expect(adapter.sync({ emitCapture: async () => {} })).rejects.toMatchObject({ name: "TransientSyncError", status: 401 });
  await expect(adapter.backfillAssets!("c", [], { uploadAsset: async () => { throw new Error("unused"); }, beforeFetch: async () => {} }))
    .rejects.toMatchObject({ name: "TransientSyncError", status: 401 });
});
