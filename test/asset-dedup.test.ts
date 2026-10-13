import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleIngestRequest, type IngestServerOptions } from "../packages/ingest/src/server";
import { assetBlobPath, resolveLocalAssetPath, storeCanonicalAsset } from "../src/store/assets";
import { ownedAssetHashes } from "../src/store/asset-reference-store";
import { assetsDirForCanonicalDir } from "../src/store/assets";
import { markSessionDeleted } from "../src/store/tombstones";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup(extra: Partial<IngestServerOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), "asset-dedup-")); roots.push(root);
  const canonicalDir = join(root, "canonical", "sessions");
  return { canonicalDir, indexPath: join(root, "index.db"), ingestToken: "tok", ...extra } as IngestServerOptions & { canonicalDir: string };
}
const auth = { authorization: "Bearer tok" };
const call = (opts: IngestServerOptions, method: string, path: string, init: RequestInit = {}) =>
  handleIngestRequest(new Request(`http://local${path}`, { method, headers: auth, ...init }), opts);
const sha = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const upload = (opts: IngestServerOptions, sourceId: string, body: string) =>
  call(opts, "POST", `/assets?source=chatgpt&source_id=${sourceId}&pointer=p-${sourceId}&filename=a.png`, { body });

test("GET /assets reports existence without bytes, requires auth, rejects bad hashes", async () => {
  const opts = setup();
  const h = sha("hello");
  expect(await (await call(opts, "GET", `/assets?sha256=${h}`)).json()).toEqual({ ok: true, exists: false, sha256: h });
  expect((await upload(opts, "one", "hello")).status).toBe(200);
  expect(await (await call(opts, "GET", `/assets?sha256=${h}`)).json()).toEqual({ ok: true, exists: true, sha256: h, size_bytes: 5 });
  expect((await handleIngestRequest(new Request(`http://local/assets?sha256=${h}`), opts)).status).toBe(401);
  for (const bad of ["", "abc", h.toUpperCase(), `${h}0`]) expect((await call(opts, "GET", `/assets?sha256=${bad}`)).status).toBe(400);
});

test("POST /assets/reference links an existing blob without bytes and preserves first-seen metadata", async () => {
  const opts = setup();
  const h = sha("hello");
  const first = await (await upload(opts, "one", "hello")).json() as any;
  const res = await call(opts, "POST", `/assets/reference?sha256=${h}&source=chatgpt&source_id=two&pointer=ptr2&filename=b.png&message_id=m2&original_url=http://x`);
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body).toMatchObject({ ok: true, pointer: "ptr2", sha256: h, size_bytes: 5 });
  expect(body.local_path).toBe(`assets/chatgpt/two/${h}.png`);
  const a = statSync(resolveLocalAssetPath(opts.canonicalDir!, first.local_path));
  expect(statSync(resolveLocalAssetPath(opts.canonicalDir!, body.local_path)).ino).toBe(a.ino);
  const root = assetsDirForCanonicalDir(opts.canonicalDir!);
  expect(ownedAssetHashes(root, "chatgpt", "two").has(h)).toBe(true);
  const meta = JSON.parse(readFileSync(`${assetBlobPath(opts.canonicalDir!, h)}.json`, "utf8"));
  expect(meta).toMatchObject({ original_pointer: "p-one", first_seen: { session_id: "chatgpt:one" } });
  // blob survives deleting the first owner while the referencing session keeps it
  expect((await call(opts, "DELETE", "/captures?source=chatgpt&source_id=one")).status).toBe(200);
  expect(existsSync(assetBlobPath(opts.canonicalDir!, h))).toBe(true);
  expect(existsSync(resolveLocalAssetPath(opts.canonicalDir!, body.local_path))).toBe(true);
  expect((await call(opts, "DELETE", "/captures?source=chatgpt&source_id=two")).status).toBe(200);
  expect(existsSync(assetBlobPath(opts.canonicalDir!, h))).toBe(false);
});

test("reference: auth, missing blob 404, tombstone 410, invalid inputs 400", async () => {
  const opts = setup();
  const h = sha("x");
  const q = (extra = "") => `/assets/reference?sha256=${h}&source=chatgpt&source_id=s&pointer=p${extra}`;
  expect((await handleIngestRequest(new Request(`http://local${q()}`, { method: "POST" }), opts)).status).toBe(401);
  expect((await call(opts, "POST", q())).status).toBe(404);
  expect((await call(opts, "POST", `/assets/reference?sha256=zz&source=chatgpt&source_id=s&pointer=p`)).status).toBe(400);
  expect((await call(opts, "POST", `/assets/reference?sha256=${h}&source=bogus&source_id=s&pointer=p`)).status).toBe(400);
  await upload(opts, "one", "x");
  markSessionDeleted(opts.canonicalDir!, { source: "chatgpt", source_id: "s", deleted_at: new Date().toISOString() });
  expect((await call(opts, "POST", q())).status).toBe(410);
  expect(existsSync(join(opts.canonicalDir!, "..", "assets", "chatgpt", "s"))).toBe(false);
});

test("upload bounds streaming bodies with and without honest content-length", async () => {
  const opts = setup({ maxAssetBytes: 10 });
  let pulled = 0, cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { pulled++; controller.enqueue(new Uint8Array(6)); if (pulled > 50) controller.close(); },
    cancel() { cancelled = true; },
  });
  const res = await call(opts, "POST", "/assets?source=chatgpt&source_id=big&pointer=p", { body: stream, duplex: "half" } as any);
  expect(res.status).toBe(413);
  expect(cancelled).toBe(true);
  expect(pulled).toBeLessThan(10);
  const declared = await call(opts, "POST", "/assets?source=chatgpt&source_id=big&pointer=p", { body: new Uint8Array(11) });
  expect(declared.status).toBe(413);
  expect((await call(opts, "POST", "/assets?source=chatgpt&source_id=ok&pointer=p", { body: new Uint8Array(10).fill(1) })).status).toBe(200);
});

test("dishonest content-length smaller than body is still bounded", async () => {
  const opts = setup({ maxAssetBytes: 10 });
  const res = await call(opts, "POST", "/assets?source=chatgpt&source_id=big&pointer=p", {
    body: new Uint8Array(64), headers: { ...auth, "content-length": "3" },
  });
  expect(res.status).toBe(413);
});

test("default store limit is 100MB and storeCanonicalAsset honors maxBytes", () => {
  const opts = setup();
  expect(() => storeCanonicalAsset({ canonicalDir: opts.canonicalDir!, source: "chatgpt", sourceId: "s", pointer: "p", bytes: new Uint8Array(5), maxBytes: 4 })).toThrow(/limit/);
});
