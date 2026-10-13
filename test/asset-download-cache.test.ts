import { expect, test } from "bun:test";
import { uploadProviderAssets } from "../packages/extension/src/providers/assets";
import { createGeminiAdapter } from "../packages/extension/src/providers/gemini";

for (const status of [429, 503]) test(`asset ${status} stops downloads with Retry-After`, async () => {
  let calls = 0;
  await expect(uploadProviderAssets(async () => { calls++; return new Response("", { status, headers: { "retry-after": "60" } }); }, async () => { throw new Error("must not upload"); },
    ["a", "b"].map(pointer => ({ source: "gemini" as const, sourceId: "c", pointer, url: `https://lh3.googleusercontent.com/${pointer}` })), { beforeFetch: async () => {} })).rejects.toMatchObject({ name: "RateLimitError", retryAfterMs: 60_000 });
  expect(calls).toBe(1);
});

test("Gemini unchanged payload is not re-emitted or re-downloaded across fresh adapters", async () => {
  const savedChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  const storage: Record<string, any> = {};
  let captures = 0, downloads = 0;
  const payload = [[[["c_c", "r_user"], null, [["prompt"], 1, [{ type: "audio", url: "https://lh3.googleusercontent.com/voice", mime_type: "audio/wav" }]], null]]];
  Object.defineProperty(globalThis, "chrome", { configurable: true, writable: true, value: {
    storage: { local: { get: (key: string, done: any) => done({ [key]: storage[key] }), set: (values: any, done: any) => { Object.assign(storage, values); done(); } } },
    runtime: { sendMessage: (message: any, done: any) => {
      if (message.type === "SCROBBLER_ASSET_LOOKUP") return done({ ok: true, asset: null });
      downloads++; done({ ok: true, bytes: [1, 2], contentType: "audio/wav" });
    } },
  } });
  try {
    for (let i = 0; i < 2; i++) {
      const result = await createGeminiAdapter(async () => new Response(JSON.stringify([["wrb.fr", "hNvQHb", JSON.stringify(payload)]])), {
        readWizData: () => ({ at: "csrf", bl: "b", fSid: "s" }), readConversationDom: () => null, listConversationIds: () => ["c"],
      }).sync({ emitCapture: async () => { captures++; }, uploadAsset: async a => ({ pointer: a.pointer, sha256: "a".repeat(64), local_path: "assets/gemini/c/hash.wav" }) });
      expect(result.captured).toBe(i === 0 ? 1 : 0);
      expect(result.skipped).toBe(i === 0 ? 0 : 1);
    }
    expect({ captures, downloads }).toEqual({ captures: 1, downloads: 1 });
  } finally { if (savedChrome) Object.defineProperty(globalThis, "chrome", savedChrome); else delete (globalThis as any).chrome; }
});
