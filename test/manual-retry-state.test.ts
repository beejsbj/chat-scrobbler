import { expect, test } from "bun:test";
import { retryCapturedFailures } from "../packages/extension/src/retry-captures";
import type { ProviderAdapter } from "../packages/extension/src/providers/types";

const previous = { source_id: "bad", attempts: 3, quarantined: true, updated_at: null, retry_after: "2099-01-01T00:00:00Z" };
test("a failed manual retry preserves quarantine history instead of resetting to attempt one", async () => {
  const provider = { source: "gemini", captureOne: async () => { throw new SyntaxError("bad payload"); } } as unknown as ProviderAdapter;
  const result = await retryCapturedFailures(provider, { captureFailures: [previous], emitCapture: async () => {}, pause: async () => {} });
  expect(result.captureFailures).toMatchObject([{ source_id: "bad", attempts: 4, quarantined: true }]);
});
