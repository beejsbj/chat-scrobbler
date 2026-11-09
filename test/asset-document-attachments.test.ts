import { expect, test } from "bun:test";
import { uploadProviderAssets, type ProviderAssetCandidate } from "../packages/extension/src/providers/assets";
import { createChatgptAdapter } from "../packages/extension/src/providers/chatgpt";
import { declaredDocumentKind, validateAssetBytes } from "../packages/extension/src/providers/asset-response";
import type { AssetFailure } from "../packages/shared/src";

const ROUTE = "/backend-api/files/file-1/download";
const enc = (text: string) => new TextEncoder().encode(text);

async function run(candidate: Partial<ProviderAssetCandidate>, response: () => Response) {
  const uploads: any[] = [], failures: AssetFailure[] = [];
  const assets = await uploadProviderAssets(async () => response(), async request => {
    uploads.push(request); return { pointer: request.pointer, local_path: "assets/chatgpt/c/hash" };
  }, [{ source: "chatgpt", sourceId: "c", pointer: "file-1", url: ROUTE, ...candidate }],
  { reportFailure: async failure => { failures.push(failure); }, outcomes: null });
  return { assets, uploads, failures };
}

test("a .json attachment the provider declared is archived", async () => {
  const body = '{"name":"config","token":"user-authored data"}';
  const { assets, uploads, failures } = await run({ filename: "config.json", contentType: "application/json" },
    () => new Response(body, { headers: { "content-type": "application/json; charset=utf-8" } }));
  expect(failures).toEqual([]);
  expect(assets).toHaveLength(1);
  expect(new TextDecoder().decode(new Uint8Array(uploads[0].bytes))).toBe(body);
  expect(uploads[0]).toMatchObject({ filename: "config.json", contentType: "application/json; charset=utf-8" });
});

test("a .html attachment the provider declared is archived", async () => {
  const { assets, failures } = await run({ filename: "report.html", contentType: "text/html" },
    () => new Response("<!doctype html><html><body>Quarterly report</body></html>", { headers: { "content-type": "text/html" } }));
  expect(failures).toEqual([]);
  expect(assets).toHaveLength(1);
});

test("a declared .json served as application/octet-stream is archived", async () => {
  const { assets, failures } = await run({ filename: "data.json" },
    () => new Response("[1,2,3]", { headers: { "content-type": "application/octet-stream" } }));
  expect(failures).toEqual([]);
  expect(assets).toHaveLength(1);
});

test("an HTML sign-in page served where an image was expected is rejected", async () => {
  const { assets, uploads, failures } = await run({ filename: "photo.png", contentType: "image/png" },
    () => new Response("<!DOCTYPE html><html><body>Sign in to continue</body></html>", { headers: { "content-type": "text/html" } }));
  expect(assets).toEqual([]);
  expect(uploads).toEqual([]);
  expect(failures.map(f => f.reason)).toEqual(["asset_download_failed"]);
});

test("an HTML sign-in page served for a declared .json attachment is rejected", async () => {
  for (const contentType of ["text/html", "application/octet-stream"]) {
    const { uploads, failures } = await run({ filename: "config.json", contentType: "application/json" },
      () => new Response("<html><body>Please log in</body></html>", { headers: { "content-type": contentType } }));
    expect(uploads).toEqual([]);
    expect(failures).toHaveLength(1);
  }
});

test("an auth JSON document served for a declared .html attachment is rejected", async () => {
  const { uploads, failures } = await run({ filename: "page.html", contentType: "text/html" },
    () => new Response('{"accessToken":"SECRET"}', { headers: { "content-type": "application/json" } }));
  expect(uploads).toEqual([]);
  expect(failures).toHaveLength(1);
});

test("JSON served for an undeclared or non-document attachment is still rejected", async () => {
  for (const declared of [{}, { filename: "photo.png", contentType: "image/png" }, { filename: "notes.txt", contentType: "application/json" }]) {
    const { uploads, failures } = await run(declared, () => new Response('{"accessToken":"SECRET"}', { headers: { "content-type": "application/json" } }));
    expect(uploads).toEqual([]);
    expect(failures).toHaveLength(1);
  }
});

test("a response filename cannot declare a document type the provider did not", async () => {
  const { uploads } = await run({}, () => new Response('{"accessToken":"SECRET"}', { headers: { "content-type": "application/json", "content-disposition": 'attachment; filename="session.json"' } }));
  expect(uploads).toEqual([]);
});

test("a content-disposition filename that contradicts the declared type is rejected", async () => {
  const { uploads } = await run({ filename: "page.html", contentType: "text/html" },
    () => new Response("<html>x</html>", { headers: { "content-type": "text/html", "content-disposition": 'attachment; filename="session.json"' } }));
  expect(uploads).toEqual([]);
});

test("declaredDocumentKind trusts a provider filename extension, then a mime type without a filename", () => {
  expect(declaredDocumentKind("a.JSON", null)).toBe("json");
  expect(declaredDocumentKind("a.htm", "text/html")).toBe("html");
  expect(declaredDocumentKind(null, "application/json")).toBe("json");
  expect(declaredDocumentKind(null, "application/vnd.api+json")).toBe("json");
  expect(declaredDocumentKind("a.json", "text/html")).toBeNull();
  expect(declaredDocumentKind("a.png", "application/json")).toBeNull();
  expect(declaredDocumentKind("noextension", "text/html")).toBe("html");
  expect(declaredDocumentKind(null, null)).toBeNull();
});

test("validateAssetBytes keeps the undeclared guard", () => {
  expect(() => validateAssetBytes(enc('{"a":1}'), "application/json")).toThrow();
  expect(() => validateAssetBytes(enc("<html></html>"), "image/png")).toThrow();
  expect(() => validateAssetBytes(enc("﻿  [1]"), null)).toThrow();
  expect(() => validateAssetBytes(enc("\x89PNG"), "image/png")).not.toThrow();
});

test("ChatGPT archives a declared .json upload that the CDN serves as application/json", async () => {
  const payload = { id: "c", mapping: { u: { message: { id: "u", author: { role: "user" }, content: { content_type: "text", parts: ["see attached"] },
    metadata: { attachments: [{ id: "file_json", name: "export.json", mime_type: "application/json" }] } } } } };
  const uploads: any[] = [];
  await createChatgptAdapter(async input => {
    if (input === "/api/auth/session") return Response.json({ accessToken: "provider-only" });
    if (input === "/backend-api/conversation/c") return Response.json(payload);
    if (input.startsWith("/backend-api/files/")) return Response.json({ status: "success", download_url: "https://files.oaiusercontent.com/export" });
    return new Response('{"rows":[1,2]}', { headers: { "content-type": "application/json" } });
  }).captureOne!("c", null, {
    emitCapture: async () => {},
    uploadAsset: async value => { uploads.push(value); return { pointer: value.pointer, local_path: "assets/chatgpt/c/hash" }; },
  });
  expect(uploads.map(u => u.filename)).toEqual(["export.json"]);
  expect(new TextDecoder().decode(new Uint8Array(uploads[0].bytes))).toBe('{"rows":[1,2]}');
});
