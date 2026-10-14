import { expect, test } from "bun:test";
import { createBrowserPageContext, createGeminiAdapter } from "../packages/extension/src/providers/gemini";
import type { FetchLike } from "../packages/extension/src/providers/types";
import { uploadProviderAssets } from "../packages/extension/src/providers/assets";

const id = "aaaa0000bbbb1111";
const uuid = "a2532b3f-751b-4d54-8890-cb3e971ab982";
const payload = [[[["c_" + id, "r_user"], null, [["keep the conversation text"], 1], null]]];
function pageAdapter(fetcher: FetchLike) {
  return createGeminiAdapter((url, init) => url.startsWith("/_/BardChatUi/")
    ? Promise.resolve(new Response(JSON.stringify([["wrb.fr", "hNvQHb", JSON.stringify(payload)]])))
    : fetcher(url, init), { ...createBrowserPageContext(), readWizData: () => ({ at: "csrf", bl: "build", fSid: "sid" }) });
}
async function onPage(origin: string, media: Array<{ tag: string; url: string; type: string }>, run: () => Promise<void>) {
  const descriptors = ["location", "document", "chrome"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const elements = media.map(m => ({ tagName: m.tag.toUpperCase(), getAttribute: (key: string) => key === "src" ? m.url : key === "type" ? m.type : null }));
  const container = { innerText: "keep the conversation text", querySelectorAll: (query: string) => query === "img[src]" ? [] : elements };
  Object.defineProperty(globalThis, "location", { configurable: true, value: { origin, pathname: `/app/${id}` } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelectorAll: () => [], querySelector: () => container } });
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: undefined });
  try { await run(); } finally { for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as any)[key]; } }
}

test("Gemini DOM audio and video blobs are read on their own page without cookies or headers", async () => {
  const blobs = ["audio", "video"].map((tag, index) => ({ tag, url: `blob:https://gemini.google.com/${uuid.slice(0, -1)}${index}`, type: `${tag}/${tag === "audio" ? "wav" : "mp4"}` }));
  await onPage("https://gemini.google.com", blobs, async () => {
    const requests: string[] = [], uploads: string[] = [], captures: any[] = [];
    await pageAdapter(async (url, init) => {
      requests.push(url);
      expect(init?.credentials).toBe("omit");
      expect(init?.headers).toBeUndefined();
      const response = new Response(new Uint8Array([1, 2]), { headers: { "content-type": blobs.find(b => b.url === url)!.type } });
      Object.defineProperty(response, "url", { value: url });
      return response;
    }).captureOne!(id, null, {
      emitCapture: async capture => { captures.push(capture); }, uploadAsset: async asset => { uploads.push(asset.pointer); return { pointer: asset.pointer, local_path: "assets/media" }; },
    });
    expect(requests).toEqual(blobs.map(b => b.url));
    expect(uploads).toEqual(requests);
    expect(captures[0].assets).toHaveLength(2);
    expect(captures[0].payload).toEqual(payload);
  });
});

for (const [origin, blob] of [["https://gemini.google.com", `blob:https://claude.ai/${uuid}`], ["https://evil.test", `blob:https://gemini.google.com/${uuid}`], ["https://gemini.google.com", `blob:null/${uuid}`]]) test(`reject DOM blob ${blob} on ${origin}`, async () => {
  await onPage(origin, [{ tag: "audio", url: blob, type: "audio/wav" }], async () => {
    let fetched = 0;
    let captured = false;
    await pageAdapter(async () => { fetched++; return new Response(new Uint8Array([1])); }).captureOne!(id, null, {
      emitCapture: async () => { captured = true; }, uploadAsset: async () => { throw new Error("must not upload"); },
    });
    expect(fetched).toBe(0);
    expect(captured).toBe(true);
  });
});

test("a blob URL injected by an API payload does not acquire the DOM-only permission", async () => {
  await onPage("https://gemini.google.com", [], async () => {
    let fetched = 0;
    const blob = `blob:https://gemini.google.com/${uuid}`;
    const assets = await uploadProviderAssets(async () => { fetched++; return new Response(new Uint8Array([1])); }, async a => ({ pointer: a.pointer, local_path: "assets/leak" }), [{
      source: "gemini", sourceId: id, pointer: blob, url: blob,
    }], { reportFailure: async () => {} });
    expect(fetched).toBe(0);
    expect(assets).toEqual([]);
  });
});

test("DOM blob bytes still reject a session document disguised as audio", async () => {
  const blob = `blob:https://gemini.google.com/${uuid}`;
  await onPage("https://gemini.google.com", [{ tag: "audio", url: blob, type: "audio/wav" }], async () => {
    let uploads = 0;
    let captured = false;
    await pageAdapter(async () => new Response('{"accessToken":"SECRET"}', { headers: { "content-type": "audio/wav" } })).captureOne!(id, null, {
      emitCapture: async () => { captured = true; }, uploadAsset: async a => { uploads++; return { pointer: a.pointer, local_path: "assets/leak" }; },
    });
    expect(uploads).toBe(0);
    expect(captured).toBe(true);
  });
});

test("backfill retries a live Gemini audio blob only when the current chat DOM still owns it", async () => {
  const blob = `blob:https://gemini.google.com/${uuid}`;
  const reference = { pointer: blob, message_id: "r_user", filename: "voice.wav", content_type: "audio/wav" };
  await onPage("https://gemini.google.com", [{ tag: "audio", url: blob, type: "audio/wav" }], async () => {
    let fetched = 0;
    const assets = await createGeminiAdapter(async (url, init) => {
      fetched++;
      expect(url).toBe(blob);
      expect(init?.credentials).toBe("omit");
      expect(init?.headers).toBeUndefined();
      return new Response(new Uint8Array([1, 2]), { headers: { "content-type": "audio/wav" } });
    }, createBrowserPageContext()).backfillAssets!(id, [reference], {
      beforeFetch: async () => {},
      uploadAsset: async asset => ({ pointer: asset.pointer, local_path: "assets/recovered.wav", sha256: "a".repeat(64) }),
    });
    expect(fetched).toBe(1);
    expect(assets).toMatchObject([{ pointer: blob, message_id: "r_user", sha256: "a".repeat(64) }]);
  });
  for (const chatId of [id, "ffff0000bbbb1111"]) await onPage("https://gemini.google.com", chatId === id ? [] : [{ tag: "audio", url: blob, type: "audio/wav" }], async () => {
    const assets = await createGeminiAdapter(async () => { throw new Error("unverified blob must not be fetched"); }, createBrowserPageContext()).backfillAssets!(chatId, [reference], {
      beforeFetch: async () => {}, uploadAsset: async () => { throw new Error("must not upload"); },
    });
    expect(assets).toEqual([]);
  });
});
