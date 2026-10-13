import { expect, test } from "bun:test";
import { uploadProviderAssets } from "../packages/extension/src/providers/assets";
import { createChatgptAdapter } from "../packages/extension/src/providers/chatgpt";

for (const source of ["chatgpt", "claude", "gemini"] as const) test(`${source}: every redirect hop must remain allowlisted with source-specific credentials`, async () => {
  const initial = source === "chatgpt" ? "/backend-api/files/file-1/download" : source === "claude"
    ? "/api/organizations/org/files/file-1/download" : "https://lh3.googleusercontent.com/media/a";
  const cdn = source === "chatgpt" ? "https://files.oaiusercontent.com/media/" : source === "claude"
    ? "https://files.claudeusercontent.com/media/" : "https://lh4.googleusercontent.com/media/";
  const requests: string[] = [];
  const assets = await uploadProviderAssets(async (url, init) => {
    requests.push(url);
    expect(init?.redirect).toBe("manual");
    if (requests.length === 1) {
      expect(init?.credentials).toBe("include");
      expect(new Headers(init?.headers).get("authorization")).toBe(source === "gemini" ? null : "Bearer SECRET");
      return new Response(null, { status: 302, headers: { location: cdn + "b" } });
    }
    expect(init?.credentials).toBe(source === "gemini" ? "include" : "omit");
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    if (requests.length === 2) return new Response(null, { status: 307, headers: { location: "c" } });
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
  }, async a => ({ pointer: a.pointer, local_path: "assets/safe" }), [
    { source, sourceId: "c", pointer: "file-1", url: initial, headers: { authorization: "Bearer SECRET" } },
  ], { beforeFetch: async () => {}, reportFailure: async () => {} });
  expect(assets).toHaveLength(1);
  expect(requests).toEqual([initial, cdn + "b", cdn + "c"]);
});

for (const location of ["https://evil.test/image", "https://claude.ai/api/organizations/org/files/f/download", "//evil.test/a", "javascript:alert(1)", "data:image/png;base64,AQID", "file:///tmp/a", "/api/auth/session", "/backend-api/me", "https://files.oaiusercontent.com/auth/session", "https://files.oaiusercontent.com.evil.test/a", "\\\\evil.test/a"]) test(`reject redirect Location ${location} before a second fetch`, async () => {
  let requests = 0;
  const assets = await uploadProviderAssets(async () => {
    requests++; return new Response(null, { status: 302, headers: { location } });
  }, async () => { throw new Error("must not upload"); }, [{ source: "chatgpt", sourceId: "c", pointer: "file-1", url: "/backend-api/files/file-1/download" }], { beforeFetch: async () => {}, reportFailure: async () => {} });
  expect(requests).toBe(1);
  expect(assets).toEqual([]);
});

test("redirect cycles stop at a bounded number of requests", async () => {
  let requests = 0;
  const assets = await uploadProviderAssets(async () => {
    requests++; return new Response(null, { status: 302, headers: { location: "https://files.oaiusercontent.com/loop" } });
  }, async () => { throw new Error("must not upload"); }, [{ source: "chatgpt", sourceId: "c", pointer: "file-1", url: "/backend-api/files/file-1/download" }], { beforeFetch: async () => {}, reportFailure: async () => {} });
  expect(requests).toBeLessThanOrEqual(6);
  expect(assets).toEqual([]);
});

test("ChatGPT direct interpreter bytes are consumed once instead of issuing the download twice", async () => {
  let downloads = 0;
  const uploaded: number[][] = [];
  await createChatgptAdapter(async url => {
    if (url === "/api/auth/session") return Response.json({ accessToken: "SECRET" });
    if (url === "/backend-api/conversation/c") return Response.json({ mapping: { m: { message: {
      id: "m", content: { parts: ["[plot](sandbox:/mnt/data/plot.png)"] },
    } } } });
    downloads++;
    return new Response(new Uint8Array([7, 8]), { headers: { "content-type": "image/png" } });
  }).captureOne!("c", null, { emitCapture: async () => {}, uploadAsset: async a => {
    uploaded.push(Array.from(a.bytes)); return { pointer: a.pointer, local_path: "assets/plot" };
  } });
  expect(downloads).toBe(1);
  expect(uploaded).toEqual([[7, 8]]);
});
