import { expect, test } from "bun:test";
import { uploadProviderAssets } from "../packages/extension/src/providers/assets";
import { createChatgptAdapter } from "../packages/extension/src/providers/chatgpt";
import { allowedAssetUrl, assetCredentials } from "../packages/extension/src/providers/asset-url";

const sources = ["chatgpt", "claude", "gemini"] as const;
const forbidden = ["/api/auth/session", "/backend-api/me", "//evil.test/image", "javascript:alert(1)", "data:image/png;base64,AQID", "file:///etc/passwd"];
for (const source of sources) for (const url of [...forbidden, ...sources.filter(s => s !== source).map(s => `https://${s === "gemini" ? "gemini.google.com" : s === "chatgpt" ? "chatgpt.com" : "claude.ai"}/api/auth/session`)]) {
  test(`${source} rejects credential probe ${url} before fetch and upload`, async () => {
    let fetched = 0, uploaded = 0;
    await uploadProviderAssets(async () => { fetched++; return Response.json({ accessToken: "SECRET" }); }, async request => {
      uploaded++; return { pointer: request.pointer, local_path: "assets/leak" };
    }, [{ source, sourceId: "c", pointer: url, url, headers: { authorization: "Bearer SECRET" } }], { reportFailure: async () => {} });
    expect({ fetched, uploaded }).toEqual({ fetched: 0, uploaded: 0 });
    expect(assetCredentials(url, source)).toBe("omit");
  });
}

test("ChatGPT session document from a conversation image field never reaches upload", async () => {
  const calls: string[] = [], bodies: string[] = [];
  await createChatgptAdapter(async input => {
    calls.push(input);
    if (input === "/api/auth/session") return Response.json({ accessToken: "SECRET" });
    return Response.json({ mapping: { m: { message: { id: "m", content: { image_url: "/api/auth/session" } } } } });
  }).captureOne!("c", null, { emitCapture: async () => {}, uploadAsset: async a => {
    bodies.push(new TextDecoder().decode(new Uint8Array(a.bytes))); return { pointer: a.pointer, local_path: "assets/leak" };
  } });
  expect(calls.filter(url => url === "/api/auth/session")).toHaveLength(1);
  expect(bodies).toEqual([]);
});

for (const [contentType, body] of [
  ["application/json", '{"accessToken":"SECRET"}'], ["text/html", "<!doctype html><html>login</html>"],
  ["image/png", '{"accessToken":"SECRET"}'], ["image/png", '{"user":{"email":"SECRET"},"expires":"tomorrow"}'], ["application/octet-stream", '{"session":{"token":"SECRET"}}'],
  ["image/png", "<html><body>Sign in</body></html>"],
]) test(`reject ${contentType} auth/document bytes before upload`, async () => {
  let uploads = 0;
  const assets = await uploadProviderAssets(async () => new Response(body, { headers: { "content-type": contentType } }), async a => {
    uploads++; return { pointer: a.pointer, local_path: "assets/leak" };
  }, [{ source: "chatgpt", sourceId: "c", pointer: "file-1", url: "/backend-api/files/file-1/download" }], { reportFailure: async () => {} });
  expect(assets).toEqual([]);
  expect(uploads).toBe(0);
});

test("media fetch refuses redirects and a nonallowlisted final response URL", async () => {
  for (const redirected of [false, true]) {
    let uploads = 0;
    await uploadProviderAssets(async (_url, init) => {
      expect(init?.redirect).toBe("manual");
      const response = redirected ? new Response("SECRET", { headers: { "content-type": "image/png" } }) : new Response(null, { status: 302, headers: { location: "https://evil.test/auth" } });
      if (redirected) Object.defineProperty(response, "url", { value: "https://evil.test/auth" });
      return response;
    }, async a => { uploads++; return { pointer: a.pointer, local_path: "assets/leak" }; }, [
      { source: "chatgpt", sourceId: "c", pointer: "file-1", url: "/backend-api/files/file-1/download" },
    ], { reportFailure: async () => {} });
    expect(uploads).toBe(0);
  }
});

test("provider credentials are limited to its download routes and Gemini media", () => {
  expect(assetCredentials("https://claude.ai/api/organizations/org/files/f/download", "chatgpt")).toBe("omit");
  expect(allowedAssetUrl("https://claude.ai/api/organizations/org/files/f/download", "gemini")).toBe(false);
  expect(assetCredentials("/backend-api/files/file-1/download", "chatgpt")).toBe("include");
  expect(assetCredentials("https://files.oaiusercontent.com/image.png", "chatgpt")).toBe("omit");
  expect(assetCredentials("https://lh3.googleusercontent.com/gg-dl/image", "gemini")).toBe("include");
});
