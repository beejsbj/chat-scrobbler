import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChatgptAdapter } from "../packages/extension/src/providers/chatgpt";
import { uploadAssetToIngest } from "../packages/extension/src/asset-upload";
import { handleIngestRequest } from "../packages/ingest/src/server";
import { readSession } from "../src/store/sessions";
import { resolveLocalAssetPath } from "../src/store/assets";
import { latestRawReference } from "../src/store/raw-catalog";
import { readRawCapture } from "../src/store/raw";
import { reparse } from "../src/core/reparse";

test("authenticated provider bytes become deduplicated blobs and raw-backed media links that reparse preserves", async () => {
  const root = mkdtempSync(join(tmpdir(), "asset-capture-flow-"));
  const opts = { canonicalDir: join(root, "canonical/sessions"), indexPath: join(root, "index/db.sqlite"), rawDir: join(root, "raw"), ingestToken: "receiver-only" };
  let byteUploads = 0;
  const receiver = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(String(input), init);
    expect(req.headers.get("authorization")).toBe("Bearer receiver-only");
    if (req.method === "POST" && new URL(req.url).pathname === "/assets") byteUploads++;
    return handleIngestRequest(req, opts);
  }) as typeof fetch;
  const adapter = createChatgptAdapter(async (input, init) => {
    if (input === "/api/auth/session") return Response.json({ accessToken: "provider-only" });
    if (input === "/backend-api/conversation/c") return Response.json({ conversation_id: "c", title: "Image", current_node: "m", mapping: {
      m: { id: "m", parent: null, children: [], message: { id: "m", author: { role: "tool", name: "image_gen" }, content: { content_type: "multimodal_text", parts: [{ content_type: "image_asset_pointer", asset_pointer: "sediment://file_img" }] } } },
    } });
    if (input.includes("/files/download/")) {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer provider-only");
      return Response.json({ download_url: "https://files.oaiusercontent.com/image" });
    }
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
  });
  try {
    for (let pass = 0; pass < 2; pass++) await adapter.captureOne!("c", null, {
      uploadAsset: asset => uploadAssetToIngest(receiver, { ingestBaseUrl: "http://receiver", ingestToken: "receiver-only", maxAssetBytes: 100 }, asset),
      emitCapture: async capture => { const res = await receiver("http://receiver/captures", { method: "POST", headers: { authorization: "Bearer receiver-only" }, body: JSON.stringify(capture) }); expect(res.status).toBe(200); },
    });
    expect(byteUploads).toBe(1);
    const session = readSession(opts.canonicalDir, "chatgpt", "c");
    const media = session.messages[0].blocks.find(block => block.type === "image");
    expect(media).toMatchObject({ sha256: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81" });
    if (!media || !("local_path" in media) || !media.local_path) throw new Error("media path absent");
    expect(Array.from(readFileSync(resolveLocalAssetPath(opts.canonicalDir, media.local_path)))).toEqual([1, 2, 3]);
    const raw = readRawCapture(opts.rawDir, latestRawReference(opts.rawDir, "chatgpt", "c")!);
    expect(raw.assets?.[0].sha256).toBe(media.sha256);
    const report = await reparse({ ...opts, session: "chatgpt:c" });
    expect(report.failed).toBe(0);
    expect(readSession(opts.canonicalDir, "chatgpt", "c").messages[0].blocks).toContainEqual(media);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);
