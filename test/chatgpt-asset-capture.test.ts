import { expect, test } from "bun:test";
import { createChatgptAdapter } from "../packages/extension/src/providers/chatgpt";
import type { RawCapture } from "../packages/shared/src";
import { resolveChatgptAssetUrl } from "../packages/extension/src/providers/chatgpt-assets";

test("ChatGPT uses the successful attachment fallback for a direct binary response", async () => {
  const url = await resolveChatgptAssetUrl(async input => input.includes("/files/download/")
    ? new Response("", { status: 404 }) : new Response(new Uint8Array([1])), {
    source: "chatgpt", sourceId: "c", pointer: "sediment://file_1", url: "/backend-api/files/download/file_1",
  });
  expect(url).toBe("/backend-api/conversation/c/attachment/file_1/download");
});

test("ChatGPT captures sediment generated images, uploads, sandbox outputs and voice audio with provider auth", async () => {
  const payload = { conversation_id: "c", mapping: {
    generated: { message: { id: "g", author: { role: "tool", name: "image_gen" }, content: {
      content_type: "multimodal_text", parts: [{ content_type: "image_asset_pointer", asset_pointer: "sediment://file_img" }],
    } } },
    user: { message: { id: "u", author: { role: "user" }, content: { content_type: "text", parts: ["read this"] },
      metadata: { attachments: [{ id: "file_doc", name: "paper.pdf", mime_type: "application/pdf" }] } } },
    output: { message: { id: "o", author: { role: "assistant" }, content: { content_type: "text", parts: ["[download](sandbox:/mnt/data/report.csv)"] } } },
    voice: { message: { id: "v", author: { role: "user" }, content: { content_type: "real_time_user_audio_video_asset_pointer",
      audio_asset_pointer: { asset_pointer: "sediment://file_audio", format: "wav" } } } },
  } };
  const uploads: any[] = [];
  let capture: RawCapture | undefined;
  const calls: string[] = [];
  await createChatgptAdapter(async (input, init) => {
    calls.push(input);
    if (input === "/api/auth/session") return Response.json({ accessToken: "provider-only" });
    if (input === "/backend-api/conversation/c") return Response.json(payload);
    if (input.startsWith("/backend-api/")) {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer provider-only");
      return Response.json({ status: "success", download_url: `https://files.oaiusercontent.com/${calls.length}` });
    }
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "application/octet-stream" } });
  }).captureOne!("c", null, {
    emitCapture: async value => { capture = value; },
    uploadAsset: async value => { uploads.push(value); return { pointer: value.pointer, local_path: "assets/chatgpt/c/hash", sha256: "a".repeat(64) }; },
  });
  expect(uploads.map(a => a.pointer)).toEqual(["sediment://file_img", "file_doc", "sandbox:/mnt/data/report.csv", "sediment://file_audio"]);
  expect(uploads.map(a => a.messageId)).toEqual(["g", "u", "o", "v"]);
  expect(capture?.assets).toHaveLength(4);
  expect(calls).toContain("/backend-api/files/download/file_img?conversation_id=c&inline=false");
  expect(calls.some(c => c.includes("/interpreter/download?") && c.includes("sandbox_path=%2Fmnt%2Fdata%2Freport.csv"))).toBe(true);
  expect(JSON.stringify(uploads)).not.toContain("provider-only");
});

test("ChatGPT resolves legacy file-service JSON download links and forwards auth only on same-origin byte fetch", async () => {
  const uploaded: any[] = [];
  await createChatgptAdapter(async (input, init) => {
    if (input === "/api/auth/session") return Response.json({ accessToken: "provider-only" });
    if (input === "/backend-api/conversation/c") return Response.json({ id: "c", mapping: { n: { message: { id: "m", content: {
      content_type: "multimodal_text", parts: [{ asset_pointer: "file-service://file-1" }],
    } } } } });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer provider-only");
    if (input === "/backend-api/files/file-1/download") return Response.json({ download_url: "/backend-api/estuary/content?id=file-1" });
    if (input.startsWith("/backend-api/estuary/content")) return new Response(new Uint8Array([7]));
    throw new Error("unexpected request");
  }).captureOne!("c", null, { emitCapture: async () => {}, uploadAsset: async a => {
    uploaded.push(a); return { pointer: a.pointer, local_path: "assets/chatgpt/c/hash" };
  } });
  expect(Array.from(uploaded[0].bytes)).toEqual([7]);
});
