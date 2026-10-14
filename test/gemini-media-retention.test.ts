import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserPageContext, createGeminiAdapter } from "../packages/extension/src/providers/gemini";
import { uploadAssetToIngest } from "../packages/extension/src/asset-upload";
import { handleIngestRequest } from "../packages/ingest/src/server";
import type { RawCapture } from "../packages/shared/src";
import { listBackfillPage } from "../src/core/asset-backfill";
import { reparse } from "../src/core/reparse";
import { resolveLocalAssetPath } from "../src/store/assets";
import { latestRawReference } from "../src/store/raw-catalog";
import { readRawCapture } from "../src/store/raw";
import { readSession } from "../src/store/sessions";
import type { Block } from "../src/schema/types";

for (const type of ["audio", "video"] as const) test(`Gemini DOM ${type} survives off-page sync, daily recapture, reparse and backfill discovery`, async () => {
  const id = "aaaa0000bbbb1111";
  const pointer = "blob:https://gemini.google.com/a2532b3f-751b-4d54-8890-cb3e971ab982";
  const payload = [[[[`c_${id}`, "r_user"], null, [["Here is my recording"], 1], [[["rc_1", ["I received it"]]]]]]];
  const root = mkdtempSync(join(tmpdir(), "gemini-media-retention-"));
  const opts = { canonicalDir: join(root, "canonical/sessions"), indexPath: join(root, "index/db.sqlite"), rawDir: join(root, "raw") };
  const receiver = ((input, init) => handleIngestRequest(new Request(String(input), init), opts)) as typeof fetch;
  const storage: Record<string, any> = {};
  const saved = ["location", "document", "chrome"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const setPage = (pathname: string) => Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "https://gemini.google.com", pathname } });
  const element = { tagName: type.toUpperCase(), getAttribute: (key: string) => key === "src" ? pointer : key === "type" ? `${type}/webm` : null };
  const main = { querySelectorAll: (selector: string) => selector === "img[src]" ? [] : [element] };
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    querySelectorAll: () => [], querySelector: (selector: string) => selector === "main" && location.pathname === `/app/${id}` ? main : null,
  } });
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: { storage: { local: {
    get: (key: string, callback: (values: object) => void) => callback({ [key]: storage[key] }),
    set: (values: object, callback: () => void) => { Object.assign(storage, values); callback(); },
  } } } });
  const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);
  let downloads = 0;
  const media = () => readSession(opts.canonicalDir, "gemini", id).messages.flatMap(message => message.blocks.filter(
    (block): block is Extract<Block, { local_path: string | null }> => block.type === type));
  try {
    const adapter = createGeminiAdapter(async (url, init) => {
      if (url.startsWith("/_/BardChatUi/")) return Response.json([["wrb.fr", "hNvQHb", JSON.stringify(payload)]]);
      expect(url).toBe(pointer);
      expect(init?.credentials).toBe("omit");
      downloads++;
      const response = new Response(bytes, { headers: { "content-type": `${type}/webm` } });
      Object.defineProperty(response, "url", { value: url });
      return response;
    }, { ...createBrowserPageContext(), listConversationIds: () => [id], readWizData: () => ({ at: "csrf", bl: "build", fSid: "sid" }) });
    const options = {
      uploadAsset: (asset: Parameters<typeof uploadAssetToIngest>[2]) => uploadAssetToIngest(receiver, { ingestBaseUrl: "http://receiver", maxAssetBytes: 1024 }, asset),
      emitCapture: async (capture: RawCapture) => {
        const response = await receiver("http://receiver/captures", { method: "POST", body: JSON.stringify(capture) });
        expect(response.status).toBe(200);
      },
    };
    setPage(`/app/${id}`);
    expect((await adapter.sync(options)).captured).toBe(1);
    const original = media();
    expect(original).toHaveLength(1);
    expect(original[0].pointer).toBe(pointer);
    expect(typeof original[0].local_path).toBe("string");
    expect(typeof original[0].sha256).toBe("string");

    setPage("/app");
    expect((await adapter.sync(options)).captured).toBe(1);
    expect(media()).toEqual(original);
    // Expiring the acknowledgement forces the periodic restore-repair capture.
    for (const value of Object.values(storage)) if (value?.acknowledgedAt) value.acknowledgedAt -= 25 * 60 * 60 * 1000;
    expect((await adapter.sync(options)).captured).toBe(1);
    expect(media()).toEqual(original);
    expect(downloads).toBe(1);
    const latest = readRawCapture(opts.rawDir, latestRawReference(opts.rawDir, "gemini", id)!);
    expect(latest.assets?.[0]).toMatchObject({ pointer, sha256: original[0].sha256 });
    expect(latest.asset_references?.[0]).toMatchObject({ pointer, content_type: `${type}/webm` });
    expect((await reparse({ ...opts, session: `gemini:${id}` })).failed).toBe(0);
    expect(media()).toEqual(original);
    const path = resolveLocalAssetPath(opts.canonicalDir, original[0].local_path!);
    expect(new Uint8Array(readFileSync(path))).toEqual(bytes);
    unlinkSync(path);
    expect(listBackfillPage(opts.canonicalDir, "gemini", null, 25).sessions).toMatchObject([
      { source_id: id, references: [{ pointer, content_type: `${type}/webm` }] },
    ]);
  } finally {
    for (const [key, descriptor] of saved) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete (globalThis as any)[key];
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
