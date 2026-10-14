import { expect, test } from "bun:test";
import { createChatgptAdapter } from "../packages/extension/src/providers/chatgpt";
import { createClaudeAdapter } from "../packages/extension/src/providers/claude";
import { createGeminiAdapter } from "../packages/extension/src/providers/gemini";
import type { ProviderSource, ConversationCaptureFailure } from "../packages/shared/src";

const stamp = "2026-06-05T12:00:00Z";
function adapterFor(source: ProviderSource, ids: string[], detail: (id: string) => Promise<Response>) {
  const fetcher = async (input: string, init?: RequestInit) => {
    if (input === "/api/auth/session") return Response.json({});
    if (input === "/api/organizations") return Response.json([{ uuid: "org" }]);
    if (input.includes("conversations?")) {
      const rows = ids.map(id => ({ id, uuid: id, update_time: stamp, updated_at: stamp }));
      return Response.json(source === "chatgpt" ? { items: rows } : rows);
    }
    const id = source === "gemini"
      ? JSON.parse(JSON.parse(new URLSearchParams(String(init?.body)).get("f.req")!)[0][0][1])[0].slice(2)
      : input.split("?")[0].split("/").at(-1)!;
    return detail(id);
  };
  return source === "gemini" ? createGeminiAdapter(fetcher, {
    listConversationIds: () => ids, readWizData: () => ({ at: "csrf", bl: "b", fSid: "s" }), readConversationDom: () => null,
  }) : (source === "chatgpt" ? createChatgptAdapter : createClaudeAdapter)(fetcher);
}
function goodDetail(source: ProviderSource) {
  return source === "gemini" ? new Response(JSON.stringify([["wrb.fr", "hNvQHb", "[[]]"]]))
    : Response.json({ mapping: {}, chat_messages: [] });
}

for (const source of ["chatgpt", "claude", "gemini"] as const) test(`${source}: an isolated permanent detail 500 does not starve the next chat over five syncs`, async () => {
  let badCalls = 0;
  let goodCaptures = 0;
  let goodCalls = 0;
  const adapter = adapterFor(source, ["bad", "good"], async id => {
    if (id === "bad") { badCalls++; return new Response("broken chat", { status: 500 }); }
    goodCalls++;
    return goodDetail(source);
  });
  let cursor: string | null = "2026-06-04T12:00:00Z";
  let failures: ConversationCaptureFailure[] = [];
  for (let run = 0; run < 5; run++) {
    const result = await adapter.sync({ lastSync: cursor, captureFailures: failures, emitCapture: async () => { goodCaptures++; } });
    failures = result.captureFailures!;
    cursor = result.maxConversationUpdatedAt;
    if (run < 3) expect(goodCalls).toBe(run + 1);
    if (run === 2) expect(cursor! > "2026-06-04T12:00:00Z").toBe(true);
  }
  expect(goodCaptures).toBeGreaterThanOrEqual(1);
  expect(badCalls).toBe(3);
  expect(failures).toMatchObject([{ source_id: "bad", attempts: 3, quarantined: true }]);
});

for (const source of ["chatgpt", "claude", "gemini"] as const) test(`${source}: three consecutive detail 5xx escalate to an environmental outage`, async () => {
  let calls = 0;
  const adapter = adapterFor(source, ["a", "b", "c", "d"], async () => { calls++; return new Response("", { status: 502 }); });
  await expect(adapter.sync({ emitCapture: async () => {} })).rejects.toMatchObject({ name: "ProviderDetailOutageError" });
  expect(calls).toBe(3);
});

for (const error of [new TypeError("bad extraction"), new DOMException("invalid processing"), new SyntaxError("bad JSON")]) test(`${error.name} in local capture processing counts per chat and lets the next chat through`, async () => {
  const captured: string[] = [];
  const result = await adapterFor("chatgpt", ["bad", "good"], async () => goodDetail("chatgpt")).sync({
    emitCapture: async capture => { if (capture.source_id === "bad") throw error; captured.push(capture.source_id); },
  });
  expect(captured).toEqual(["good"]);
  expect(result.captureFailures).toMatchObject([{ source_id: "bad", attempts: 1, quarantined: false }]);
});

test("invalid Claude base64 is an asset failure: text and the following chat still capture", async () => {
  const captures: any[] = [];
  let uploads = 0;
  const adapter = adapterFor("claude", ["bad", "good"], async id => id === "good" ? goodDetail("claude") : Response.json({ chat_messages: [{
    uuid: "m", content: [{ type: "text", text: "keep this text" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "not valid base64!!!" } }],
  }] }));
  const result = await adapter.sync({ emitCapture: async capture => { captures.push(capture); }, uploadAsset: async () => { uploads++; throw new Error("must not upload"); } });
  expect(result.captureFailures).toEqual([]);
  expect(captures.map(c => c.source_id)).toEqual(["bad", "good"]);
  expect(captures[0].payload.chat_messages[0].content[0].text).toBe("keep this text");
  expect(captures[0].assets).toEqual([]);
  expect(captures[0].asset_references).toHaveLength(1);
  expect(uploads).toBe(0);
});

for (const status of [400, 413, 422]) test(`ingest ${status} is counted per chat and does not block the following chat`, async () => {
  const { DeterministicCaptureError } = await import("../packages/extension/src/providers/sync-errors");
  const captured: string[] = [];
  const result = await adapterFor("chatgpt", ["bad", "good"], async () => goodDetail("chatgpt")).sync({
    emitCapture: async capture => {
      if (capture.source_id === "bad") throw new DeterministicCaptureError("Receiver rejected capture", status);
      captured.push(capture.source_id);
    },
  });
  expect(captured).toEqual(["good"]);
  expect(result.captureFailures).toMatchObject([{ source_id: "bad", attempts: 1 }]);
});

for (const source of ["chatgpt", "claude", "gemini"] as const) test(`${source}: the same three adjacent permanent 500 chats quarantine and release the cursor over four runs`, async () => {
  const { syncErrorResponse } = await import("../packages/extension/src/sync-error-response");
  let failureStreak: any[] = [], failures: ConversationCaptureFailure[] = [];
  let cursor: string | null = "2026-06-04T00:00:00Z";
  let reachedGood = 0;
  for (let run = 0; run < 4; run++) {
    const adapter = adapterFor(source, ["a", "b", "c", "good"], async id => {
      if (id !== "good") return new Response("permanent failure", { status: 500 });
      reachedGood++;
      return goodDetail(source);
    });
    try {
      const result = await adapter.sync({ lastSync: cursor, captureFailures: failures, detailFailureStreak: failureStreak, emitCapture: async () => {} } as any);
      failureStreak = (result as any).detailFailureStreak;
      failures = result.captureFailures!;
      cursor = result.maxConversationUpdatedAt;
    } catch (error) {
      expect(run).toBe(0);
      const response = syncErrorResponse(error) as any;
      expect(response.syncIssue.reason).toBe("provider_detail_outage");
      failureStreak = response.detailFailureStreak;
      expect(failures).toEqual([]);
    }
  }
  expect(reachedGood).toBe(3);
  expect(failures).toHaveLength(3);
  expect(failures.every(f => f.attempts === 3 && f.quarantined)).toBe(true);
  expect(cursor! > "2026-06-04T00:00:00Z").toBe(true);
});

for (const source of ["chatgpt", "claude", "gemini"] as const) test(`${source}: a full detail outage still counts nothing over four runs with the same identities`, async () => {
  const { syncErrorResponse } = await import("../packages/extension/src/sync-error-response");
  let detailFailureStreak: any[] = [];
  for (let run = 0; run < 4; run++) {
    let captured = 0;
    try {
      await adapterFor(source, ["a", "b", "c", "d"], async () => new Response("outage", { status: 500 })).sync({
        detailFailureStreak, emitCapture: async () => { captured++; },
      });
      throw new Error("must abort the outage");
    } catch (error) {
      const response = syncErrorResponse(error);
      expect(response.syncIssue?.reason).toBe("provider_detail_outage");
      detailFailureStreak = response.detailFailureStreak!;
    }
    expect(captured).toBe(0);
  }
});

for (const source of ["chatgpt", "claude", "gemini"] as const) test(`${source}: a different failing cohort aborts instead of counting a suspected outage`, async () => {
  const previous = ["a", "b", "c"].map(source_id => ({ source_id, updated_at: source === "gemini" ? null : stamp }));
  await expect(adapterFor(source, ["good", "x", "y", "z", "later"], async id => id === "good" ? goodDetail(source) : new Response("outage", { status: 500 })).sync({
    detailFailureStreak: previous, emitCapture: async () => {},
  })).rejects.toMatchObject({ name: "ProviderDetailOutageError" });
});

for (const source of ["chatgpt", "claude"] as const) test(`${source}: a previously confirmed local cohort can retry behind the cursor without an unnecessary outage abort`, async () => {
  const result = await adapterFor(source, ["a", "b", "c", "good"], async id => id === "good" ? goodDetail(source) : new Response("permanent", { status: 500 })).sync({
    lastSync: "2026-06-06T00:00:00Z",
    detailFailureStreak: ["a", "b", "c"].map(source_id => ({ source_id, updated_at: stamp, confirmed_local: true })),
    captureFailures: ["a", "b", "c"].map(source_id => ({ source_id, updated_at: stamp, attempts: 3, quarantined: true, retry_after: "2000-01-01T00:00:00Z" })),
    emitCapture: async () => {},
  });
  expect(result.captureFailures).toHaveLength(3);
  expect(result.captureFailures!.every(f => f.attempts === 4 && Date.parse(f.retry_after!) > Date.now())).toBe(true);
});

test("a duplicate listing identity that later succeeds clears remembered 5xx state", async () => {
  let calls = 0;
  const result = await adapterFor("chatgpt", ["a", "good", "a"], async id => id === "a" && ++calls === 1 ? new Response("500", { status: 500 }) : goodDetail("chatgpt")).sync({ emitCapture: async () => {} });
  expect(result.captureFailures).toEqual([]);
  expect(result.detailFailureStreak).toEqual([]);
});
