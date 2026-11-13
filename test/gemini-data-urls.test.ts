import { expect, test } from "bun:test";
import { createGeminiAdapter, type GeminiPageContext } from "../packages/extension/src/providers/gemini";
import { geminiApiAssetCandidates, inlineDataCandidates, scanGeminiApiAssets } from "../packages/extension/src/providers/gemini-assets";
import type { RawCapture } from "../packages/shared/src";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const dataUrl = `data:image/png;base64,${base64(PNG)}`;
const digestOf = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), b => b.toString(16).padStart(2, "0")).join("");
const rpc = (payload: unknown) => new Response(JSON.stringify([["wrb.fr", "hNvQHb", JSON.stringify(payload)]]));
const wiz = { at: "csrf", bl: "build", fSid: "sid" };
const page = (assets: ReturnType<NonNullable<GeminiPageContext["readConversationAssets"]>>): GeminiPageContext =>
  ({ readWizData: () => wiz, listConversationIds: () => ["c"], readConversationDom: () => null, readConversationAssets: () => assets });

test("Gemini API data: media is held apart from link candidates", () => {
  const payload = [[[["c_c", "r_user"], null, [["prompt"], 1, [{ type: "image", url: dataUrl, mime_type: "image/png" }]], null]]];
  const scan = scanGeminiApiAssets(payload, "c");
  expect(scan.candidates).toEqual([]);
  expect(scan.inline).toEqual([{ dataUrl, messageId: "r_user", mime: "image/png", filename: null }]);
  expect(geminiApiAssetCandidates(payload, "c")).toEqual([]);
});

test("a descriptor with a file id and a data: download url keeps the id as pointer and decodes the bytes", async () => {
  const payload = [[[["c_c", "r_user"], null, [["prompt"], 1, [{ type: "image", file_id: "file-1", download_url: dataUrl, mime_type: "image/png" }]], null]]];
  expect(geminiApiAssetCandidates(payload, "c")).toEqual([]);
  const { inline } = scanGeminiApiAssets(payload, "c");
  expect(await inlineDataCandidates(inline, "c", 1024)).toMatchObject([{ pointer: "file-1", url: null, messageId: "r_user", inlineBase64: base64(PNG) }]);
});

test("inline data candidates use a short digest pointer and carry the bytes once", async () => {
  const [candidate] = await inlineDataCandidates([{ dataUrl, messageId: "m", mime: null, filename: null }], "c", 1024);
  expect(candidate).toMatchObject({ pointer: `gemini-inline:sha256:${await digestOf(dataUrl)}`, url: null, messageId: "m", contentType: "image/png", inlineBase64: base64(PNG) });
  expect(candidate.pointer.length).toBeLessThan(100);
});

test("inline data candidates drop oversized, svg, non-base64 and non-media data URLs", async () => {
  const media = ["data:image/svg+xml,%3Csvg%2F%3E", `data:image/svg+xml;base64,${base64(PNG)}`, "data:text/html;base64,PGI+", `data:image/png;base64,${"A".repeat(400)}`, "data:image/png;base64,@@@@"]
    .map(dataUrl => ({ dataUrl, messageId: null, mime: null, filename: null }));
  expect(await inlineDataCandidates(media, "c", 100)).toEqual([]);
});

test("Gemini capture stores a page data: image through the inline path and never archives the data URL", async () => {
  const captures: RawCapture[] = [];
  const uploads: any[] = [];
  const reports: string[] = [];
  const logs = console.error;
  console.error = (line: string) => { reports.push(line); };
  try {
    await createGeminiAdapter(async () => rpc([["conversation"]]),
      page([{ pointer: dataUrl, url: dataUrl, contentType: undefined }])).captureOne!("c", null, {
      uploadAsset: async asset => { uploads.push(asset); return { pointer: asset.pointer, local_path: "assets/gemini/c/hash.png", sha256: "a".repeat(64) }; },
      emitCapture: async capture => { captures.push(capture); },
    });
  } finally { console.error = logs; }
  const pointer = `gemini-inline:sha256:${await digestOf(dataUrl)}`;
  expect(uploads).toHaveLength(1);
  expect(uploads[0]).toMatchObject({ pointer, originalUrl: null, contentType: "image/png" });
  expect(Array.from(uploads[0].bytes)).toEqual(Array.from(PNG));
  expect(captures[0]!.assets).toMatchObject([{ pointer }]);
  expect(captures[0]!.asset_references).toMatchObject([{ pointer }]);
  expect(JSON.stringify({ ...captures[0], payload: null })).not.toContain("data:");
  expect(reports).toEqual([]);
});

test("Gemini capture of an API data: image does not duplicate the base64 outside the payload", async () => {
  const payload = [[[["c_c", "r_user"], null, [["prompt"], 1, [{ type: "image", url: dataUrl, mime_type: "image/png" }]], null]]];
  const captures: RawCapture[] = [];
  await createGeminiAdapter(async () => rpc(payload), page([{ pointer: dataUrl, url: dataUrl }])).captureOne!("c", null, {
    uploadAsset: async asset => ({ pointer: asset.pointer, local_path: "assets/gemini/c/hash.png", sha256: "a".repeat(64) }),
    emitCapture: async capture => { captures.push(capture); },
  });
  const pointer = `gemini-inline:sha256:${await digestOf(dataUrl)}`;
  // The API copy owns the message; the identical page copy is the same asset.
  expect(captures[0]!.assets).toMatchObject([{ pointer, message_id: "r_user" }]);
  expect(JSON.stringify({ ...captures[0], payload: null })).not.toContain("data:");
});

test("an oversized page data: image is dropped without an asset record or failure report", async () => {
  const big = `data:image/png;base64,${"A".repeat(4000)}`;
  const captures: RawCapture[] = [];
  const logs = console.error;
  const lines: string[] = [];
  console.error = (line: string) => { lines.push(line); };
  const original = (globalThis as any).chrome;
  (globalThis as any).chrome = { storage: { local: { get: (key: string, cb: (v: object) => void) => cb({ [key]: key === "scrobbler.settings" ? { maxAssetBytes: 100 } : undefined }), set: (_v: object, cb: () => void) => cb() } } };
  try {
    await createGeminiAdapter(async () => rpc([["conversation"]]), page([{ pointer: big, url: big }])).captureOne!("c", null, {
      uploadAsset: async () => { throw new Error("must not upload"); },
      emitCapture: async capture => { captures.push(capture); },
    });
  } finally { console.error = logs; (globalThis as any).chrome = original; }
  expect(captures[0]!.assets).toEqual([]);
  expect(captures[0]!.asset_references).toEqual([]);
  expect(lines).toEqual([]);
});

test("backfill recovers a data: image still shown on the page, under its inline pointer", async () => {
  const pointer = `gemini-inline:sha256:${await digestOf(dataUrl)}`;
  const uploads: any[] = [];
  const assets = await createGeminiAdapter(async () => { throw new Error("no network"); }, page([{ pointer: dataUrl, url: dataUrl }])).backfillAssets!("c",
    [{ pointer, message_id: null, filename: null, content_type: "image/png" }], {
      beforeFetch: async () => {},
      uploadAsset: async asset => { uploads.push(asset); return { pointer: asset.pointer, local_path: "assets/gemini/c/hash.png", sha256: "b".repeat(64) }; },
    });
  expect(assets).toMatchObject([{ pointer, sha256: "b".repeat(64) }]);
  expect(Array.from(uploads[0].bytes)).toEqual(Array.from(PNG));
});
