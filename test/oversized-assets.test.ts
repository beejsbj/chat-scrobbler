import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleIngestRequest } from "../packages/ingest/src/server";
import { readBoundedBody } from "../packages/ingest/src/bounded-body";
import { ingestMaxRequestBodySize } from "../packages/ingest/src/request-body-limit";
import { assetUploadTimeoutMs, uploadAssetToIngest } from "../packages/extension/src/asset-upload";
import { fetchAllowedAsset } from "../packages/extension/src/providers/asset-fetch";
import { configuredAssetLimit, isOversizedContentLength, MAX_PROVIDER_ASSET_BYTES } from "../packages/extension/src/providers/assets";
import { monitorReport } from "../src/monitor/report";
import { openIndex } from "../src/indexer/sqlite";
import { MAX_ASSET_BYTES } from "../src/store/assets";
import { DEFAULT_MAX_ASSET_BYTES, LEGACY_MAX_ASSET_BYTES, initialBodyBufferSize, nextBodyBufferSize } from "../packages/shared/src";

const MiB = 1024 * 1024;
const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const root = () => { const dir = mkdtempSync(join(tmpdir(), "oversized-")); roots.push(dir); return dir; };

test("the default asset limit is 512 MiB everywhere it is enforced", () => {
  expect(DEFAULT_MAX_ASSET_BYTES).toBe(512 * MiB);
  expect(LEGACY_MAX_ASSET_BYTES).toBe(100 * MiB);
  expect(MAX_ASSET_BYTES).toBe(DEFAULT_MAX_ASSET_BYTES);
  expect(MAX_PROVIDER_ASSET_BYTES).toBe(DEFAULT_MAX_ASSET_BYTES);
  expect(ingestMaxRequestBodySize(DEFAULT_MAX_ASSET_BYTES)).toBe(DEFAULT_MAX_ASSET_BYTES);
  expect(isOversizedContentLength(String(150 * MiB))).toBe(false);
  expect(isOversizedContentLength(String(513 * MiB))).toBe(true);
});

test("the receiver stores an asset above the former 100 MiB cap and still refuses one above its configured limit", async () => {
  const dir = root();
  const opts = { canonicalDir: join(dir, "canonical", "sessions"), indexPath: join(dir, "index.db"), ingestToken: null };
  openIndex(opts.indexPath).close();
  const body = new Uint8Array(101 * MiB);
  body[0] = 1; body[body.length - 1] = 2;
  const stored = await handleIngestRequest(new Request("http://local/assets?source=gemini&source_id=g1&pointer=video", { method: "POST", headers: { "content-type": "video/mp4" }, body }), opts);
  expect(stored.status).toBe(200);
  expect(await stored.json()).toMatchObject({ ok: true, size_bytes: 101 * MiB });
  const refused = await handleIngestRequest(new Request("http://local/assets?source=gemini&source_id=g1&pointer=video2", { method: "POST", body: new Uint8Array(2 * MiB) }), { ...opts, maxAssetBytes: MiB });
  expect(refused.status).toBe(413);
}, 30_000);

test("a body with a declared length is read into one buffer, and a body that outruns its declared length is still bounded", async () => {
  const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5]), new Uint8Array([6])];
  const stream = () => new ReadableStream({ start(c) { for (const chunk of chunks) c.enqueue(chunk); c.close(); } });
  const declared = new Request("http://local/", { method: "POST", body: stream(), duplex: "half" } as any);
  declared.headers.set("content-length", "6");
  expect([...await readBoundedBody(declared, 100)]).toEqual([1, 2, 3, 4, 5, 6]);
  const lying = new Request("http://local/", { method: "POST", body: stream(), duplex: "half", headers: { "content-length": "2" } } as any);
  expect([...await readBoundedBody(lying, 100)]).toEqual([1, 2, 3, 4, 5, 6]);
  const tooBig = new Request("http://local/", { method: "POST", body: stream(), duplex: "half", headers: { "content-length": "2" } } as any);
  await expect(readBoundedBody(tooBig, 4)).rejects.toThrow("byte limit");
});

test("a declared length only caps growth: an honest multi-chunk body past the initial buffer is intact, and a huge declaration with a tiny body returns just the bytes sent", async () => {
  const size = 40 * MiB;
  const source = new Uint8Array(size).map((_, i) => i % 251);
  const sliced = () => new ReadableStream<Uint8Array>({ start(c) { for (let at = 0; at < size; at += 3 * MiB) c.enqueue(source.subarray(at, Math.min(size, at + 3 * MiB))); c.close(); } });
  const honest = await readBoundedBody(new Request("http://local/", { method: "POST", body: sliced(), duplex: "half", headers: { "content-length": String(size) } } as any), 512 * MiB);
  expect(honest.byteLength).toBe(size);
  expect(honest[size - 1]).toBe(source[size - 1]);
  expect(honest[17 * MiB + 5]).toBe(source[17 * MiB + 5]);
  const tiny = await readBoundedBody(new Request("http://local/", { method: "POST", body: new Uint8Array([9, 8, 7]), duplex: "half", headers: { "content-length": String(512 * MiB) } } as any), 512 * MiB);
  expect([...tiny]).toEqual([9, 8, 7]);
});

test("a body with no or understated Content-Length grows geometrically instead of reallocating per chunk", async () => {
  const size = 48 * MiB, chunk = 64 * 1024;
  const source = new Uint8Array(size).map((_, i) => (i * 7) % 253);
  const stream = () => new ReadableStream<Uint8Array>({ start(c) { for (let at = 0; at < size; at += chunk) c.enqueue(source.subarray(at, at + chunk)); c.close(); } });
  const started = performance.now();
  const noLength = await readBoundedBody(new Request("http://local/", { method: "POST", body: stream(), duplex: "half" } as any), 512 * MiB);
  const understated = await readBoundedBody(new Request("http://local/", { method: "POST", body: stream(), duplex: "half", headers: { "content-length": String(MiB) } } as any), 512 * MiB);
  expect(noLength.byteLength).toBe(size);
  expect(understated.byteLength).toBe(size);
  for (const out of [noLength, understated]) { expect(out[size - 1]).toBe(source[size - 1]); expect(out[20 * MiB + 3]).toBe(source[20 * MiB + 3]); }
  // 768 per-chunk reallocations of tens of MiB would take far longer than geometric growth.
  expect(performance.now() - started).toBeLessThan(8000);
  const response = new Response(stream(), { headers: {} });
  const { boundedAssetBuffer } = await import("../packages/extension/src/providers/asset-bytes");
  const downloaded = await boundedAssetBuffer(response, 512 * MiB);
  expect(downloaded.byteLength).toBe(size);
  expect(downloaded[size - 1]).toBe(source[size - 1]);
}, 30_000);

test("buffer growth ends exactly at an honest declared length, including the chunk that completes it", () => {
  expect(initialBodyBufferSize(512 * MiB)).toBe(16 * MiB);
  expect(initialBodyBufferSize(0)).toBe(0);
  // An honest 257 MiB body: the 256 MiB buffer fills, the last chunk makes total equal declared.
  expect(nextBodyBufferSize(256 * MiB, 257 * MiB, 257 * MiB, 512 * MiB)).toBe(257 * MiB);
  expect(nextBodyBufferSize(16 * MiB, 17 * MiB, 257 * MiB, 512 * MiB)).toBe(32 * MiB);
  // Understated or missing declarations grow geometrically toward the limit instead.
  expect(nextBodyBufferSize(16 * MiB, 17 * MiB, MiB, 512 * MiB)).toBe(32 * MiB);
  expect(nextBodyBufferSize(0, 64 * 1024, 0, 512 * MiB)).toBe(64 * 1024);
  expect(nextBodyBufferSize(64 * 1024, 128 * 1024, 0, 512 * MiB)).toBe(128 * 1024);
  expect(nextBodyBufferSize(256 * MiB, 257 * MiB, 0, 512 * MiB)).toBe(512 * MiB);
  expect(nextBodyBufferSize(256 * MiB, 300 * MiB, 0, 300 * MiB)).toBe(300 * MiB);
});

test("the extension uploads a Uint8Array body without copying it, and gives large uploads more time", async () => {
  expect(assetUploadTimeoutMs(0)).toBe(60_000);
  expect(assetUploadTimeoutMs(100 * MiB)).toBe(110_000);
  expect(assetUploadTimeoutMs(512 * MiB)).toBe(300_000);
  const bytes = new Uint8Array([1, 2, 3, 4]);
  let posted: unknown;
  const fetcher = (async (_url: string, init: RequestInit) => {
    if (init.method !== "POST") return Response.json({ ok: true, exists: false });
    posted = init.body;
    return Response.json({ ok: true, pointer: "p", local_path: "assets/claude/c/x.bin", sha256: "", size_bytes: 4 });
  }) as unknown as typeof fetch;
  await uploadAssetToIngest(fetcher, { ingestBaseUrl: "http://local", maxAssetBytes: 512 * MiB }, { source: "claude", sourceId: "c", pointer: "p", bytes }).catch(() => {});
  expect(posted).toBe(bytes);
});

test("a stored extension limit equal to the former default follows the new default; a chosen limit is kept", async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  const withLimit = (value: unknown) => Object.defineProperty(globalThis, "chrome", { configurable: true, writable: true, value: { storage: { local: { get: (_k: string, done: any) => done({ "scrobbler.settings": { maxAssetBytes: value } }) } } } });
  try {
    withLimit(100 * MiB);
    expect(await configuredAssetLimit()).toBe(512 * MiB);
    withLimit(200 * MiB);
    expect(await configuredAssetLimit()).toBe(200 * MiB);
    withLimit(undefined);
    expect(await configuredAssetLimit()).toBe(512 * MiB);
  } finally { if (saved) Object.defineProperty(globalThis, "chrome", saved); else delete (globalThis as any).chrome; }
});

test("a slow body is allowed to finish after its headers arrived, while a stalled request still times out", async () => {
  const slowBody = () => new Response(new ReadableStream({ async start(c) { await Bun.sleep(80); c.enqueue(new Uint8Array([1, 2, 3])); c.close(); } }), { headers: { "content-type": "image/png" } });
  const { response } = await fetchAllowedAsset((async () => slowBody()) as unknown as typeof fetch, "https://lh3.googleusercontent.com/a", "gemini", undefined, { headerMs: 20, bodyMs: 1000 });
  expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
  const stalled = (async (_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
  await expect(fetchAllowedAsset(stalled, "https://lh3.googleusercontent.com/a", "gemini", undefined, { headerMs: 20, bodyMs: 1000 })).rejects.toThrow("Provider asset network unavailable");
});

test("once an oversized asset is stored its size failure leaves the monitor, and only still oversized assets remain", async () => {
  const dir = root();
  const opts = { canonicalDir: join(dir, "canonical", "sessions"), indexPath: join(dir, "index.db"), ingestToken: null };
  openIndex(opts.indexPath).close();
  const logs = spyOn(console, "error").mockImplementation(() => {});
  try {
    const report = (pointer: string) => handleIngestRequest(new Request("http://local/status", { method: "POST", body: JSON.stringify({ source: "gemini", conversations: [],
      asset_failures: [{ source_id: "g1", message_id: "m1", reason: "asset_too_large", pointer }] }) }), opts);
    await report("fits-now"); await report("still-too-big");
    expect((await monitorReport(opts)).assets.recent_failures_by_reason).toEqual({ asset_too_large: 2 });
    const upload = await handleIngestRequest(new Request("http://local/assets?source=gemini&source_id=g1&message_id=m1&pointer=fits-now", { method: "POST", body: new Uint8Array(101 * MiB).fill(7) }), opts);
    expect(upload.status).toBe(200);
    expect((await monitorReport(opts)).assets.recent_failures_by_reason).toEqual({ asset_too_large: 1 });
  } finally { logs.mockRestore(); }
}, 30_000);
