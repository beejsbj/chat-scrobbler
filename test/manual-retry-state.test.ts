import { expect, test } from "bun:test";
import { retryCapturedFailures } from "../packages/extension/src/retry-captures";
import type { ProviderAdapter } from "../packages/extension/src/providers/types";

const previous = { source_id: "bad", attempts: 3, quarantined: true, updated_at: null, retry_after: "2099-01-01T00:00:00Z" };
test("a failed manual retry preserves quarantine history instead of resetting to attempt one", async () => {
  const provider = { source: "gemini", captureOne: async () => { throw new SyntaxError("bad payload"); } } as unknown as ProviderAdapter;
  const result = await retryCapturedFailures(provider, { captureFailures: [previous], emitCapture: async () => {}, pause: async () => {} });
  expect(result.captureFailures).toMatchObject([{ source_id: "bad", attempts: 4, quarantined: true }]);
});

test("manual retry also stops an environmental streak of detail 5xx without returning replacement failure state", async () => {
  const { ProviderDetailError } = await import("../packages/extension/src/providers/sync-errors");
  let calls = 0;
  const provider = { source: "chatgpt", captureOne: async () => { calls++; throw new ProviderDetailError(500); } } as unknown as ProviderAdapter;
  const records = ["a", "b", "c", "d"].map(source_id => ({ ...previous, source_id }));
  await expect(retryCapturedFailures(provider, { captureFailures: records, emitCapture: async () => {}, pause: async () => {} }))
    .rejects.toMatchObject({ name: "TransientSyncError" });
  expect(calls).toBe(3);
  expect(records.every(r => r.attempts === 3)).toBe(true);
});
