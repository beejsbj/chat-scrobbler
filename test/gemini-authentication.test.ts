import { expect, test } from "bun:test";
import { createGeminiAdapter, type GeminiPageContext } from "../packages/extension/src/providers/gemini";
import { retryCapturedFailures } from "../packages/extension/src/retry-captures";
import { syncErrorResponse } from "../packages/extension/src/sync-error-response";
import type { ConversationCaptureFailure } from "../packages/shared/src";

const stamp = "2026-06-05T12:00:00Z";
const page = (ids: string[] = ["bad", "good"]): GeminiPageContext => ({
  readWizData: () => ({ at: "page-token", bl: "build", fSid: "sid" }), listConversationIds: () => ids, readConversationDom: () => null, readConversationAssets: () => [] });
const wizPage = (at: string) => new Response(`<script>window.WIZ_global_data = {"SNlM0e":"${at}","cfb2h":"build","FdrFJe":"sid"}</script>`);
const signedOut = () => new Response("<html>Sign in</html>");
const good = () => new Response(JSON.stringify([["wrb.fr", "hNvQHb", JSON.stringify([[]])]]));

/** `session` answers the page request that re-checks the Google session. */
function adapter(status: number, session: () => Response | Promise<Response>, counts = { details: 0, probes: 0 }) {
  return { counts, adapter: createGeminiAdapter(async url => {
    if (String(url).startsWith("/_/BardChatUi/")) { counts.details++; return String(url).includes("bad") || counts.details === 1 ? new Response("denied", { status }) : good(); }
    counts.probes++;
    expect(url).toBe("/app");
    return session();
  }, page()) };
}
const records = (): ConversationCaptureFailure[] => ["a", "b", "c"].map(source_id => ({ source_id, attempts: 2, quarantined: false, updated_at: null, retry_after: "2000-01-01T00:00:00Z" }));

for (const status of [401, 403]) {
  for (const [label, session] of [["signed out", signedOut], ["a changed at token", () => wizPage("rotated")]] as const) {
    test(`Gemini manual retry with ${label} (${status}) aborts on the first chat and touches no attempts`, async () => {
      const { adapter: gemini, counts } = adapter(status, session);
      const failures = records();
      const result = await retryCapturedFailures(gemini, { captureFailures: failures, emitCapture: async () => {}, pause: async () => {} }).then(() => null, error => error);
      expect(result).toMatchObject({ name: "TransientSyncError", status });
      expect(syncErrorResponse(result).captureFailures).toEqual(records());
      expect(failures.every(r => r.attempts === 2)).toBe(true);
      expect(counts).toEqual({ details: 1, probes: 1 });
    });
    test(`Gemini sync with ${label} (${status}) aborts with no attempts`, async () => {
      const result = await adapter(status, session).adapter.sync({ emitCapture: async () => {} }).then(() => null, error => error);
      expect(result).toMatchObject({ name: "TransientSyncError", status });
      expect(syncErrorResponse(result).captureFailures).toEqual([]);
    });
  }
  test(`Gemini manual retry (${status}) with an unchanged session counts the attempt and reaches the next chat`, async () => {
    const { adapter: gemini } = adapter(status, () => wizPage("page-token"));
    const result = await retryCapturedFailures(gemini, { captureFailures: records(), emitCapture: async () => {}, pause: async () => {} });
    expect(result).toMatchObject({ captured: 2, failed: 1 });
    expect(result.captureFailures).toMatchObject([{ source_id: "a", attempts: 3 }]);
  });
  test(`Gemini detail ${status} with an unreachable session check stays transient`, async () => {
    const gemini = createGeminiAdapter(async url => { if (String(url) === "/app") throw new TypeError("offline"); return new Response("denied", { status }); }, page());
    await expect(gemini.captureOne!("bad", null, { emitCapture: async () => {} })).rejects.toMatchObject({ name: "TransientSyncError" });
  });
}

test("Gemini non-auth rejections never trigger a session check", async () => {
  const { adapter: gemini, counts } = adapter(404, signedOut);
  await expect(gemini.captureOne!("bad", null, { emitCapture: async () => {} })).rejects.toMatchObject({ name: "DeterministicCaptureError", status: 404 });
  expect(counts.probes).toBe(0);
});
