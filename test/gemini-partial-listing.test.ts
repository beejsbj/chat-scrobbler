import { expect, test } from "bun:test";
import { createGeminiAdapter } from "../packages/extension/src/providers/gemini";

test("Gemini retains hidden failures across partial sidebar listings without pinning the cursor", async () => {
  const previous = [
    { source_id: "hidden", updated_at: null, attempts: 2, quarantined: false },
    { source_id: "due", updated_at: null, attempts: 3, quarantined: true, retry_after: "2000-01-01T00:00:00Z" },
  ];
  const oldCursor = "2026-01-01T00:00:00Z";
  const adapter = createGeminiAdapter(async () => new Response(JSON.stringify([["wrb.fr", "hNvQHb", "[[]]"]])), {
    listConversationIds: () => ["visible"], readWizData: () => ({ at: "csrf", bl: "build", fSid: "sid" }), readConversationDom: () => null,
  });
  const result = await adapter.sync({ lastSync: oldCursor, captureFailures: previous, emitCapture: async () => {} });
  expect(result.captureFailures).toEqual(previous);
  expect(Date.parse(result.maxConversationUpdatedAt!)).toBeGreaterThan(Date.parse(oldCursor));
});

test("a hidden Gemini chat retains its attempt history when it returns to the sidebar", async () => {
  const previous = [{ source_id: "hidden", updated_at: null, attempts: 2, quarantined: false }];
  let ids = ["visible"];
  const adapter = createGeminiAdapter(async (_url, init) => {
    const id = JSON.parse(JSON.parse(new URLSearchParams(String(init?.body)).get("f.req")!)[0][0][1])[0].slice(2);
    return id === "hidden" ? new Response("missing", { status: 404 }) : new Response(JSON.stringify([["wrb.fr", "hNvQHb", "[[]]"]]));
  }, { listConversationIds: () => ids, readWizData: () => ({ at: "csrf", bl: "build", fSid: "sid" }), readConversationDom: () => null });
  const first = await adapter.sync({ captureFailures: previous, emitCapture: async () => {} });
  ids = ["hidden", "visible"];
  const second = await adapter.sync({ captureFailures: first.captureFailures, emitCapture: async () => {} });
  expect(second.captureFailures).toMatchObject([{ source_id: "hidden", attempts: 3, quarantined: true }]);
});
