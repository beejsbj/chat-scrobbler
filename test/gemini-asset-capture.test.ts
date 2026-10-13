import { expect, test } from "bun:test";
import { createGeminiAdapter } from "../packages/extension/src/providers/gemini";
import { geminiApiAssetCandidates } from "../packages/extension/src/providers/gemini-assets";

const url = (name: string) => `https://lh3.googleusercontent.com/${name}`;

test("Gemini discovers uploaded audio, video and documents from API metadata before DOM fallback", () => {
  const payload = [[[["c_c", "r_user"], null, [["prompt"], 1, [
    { type: "audio", url: url("voice"), name: "voice.wav", mime_type: "audio/wav" },
    { type: "video", download_url: url("clip"), mime_type: "video/mp4" },
    { type: "file", url: url("paper"), mime_type: "application/pdf" },
  ]], null]]];
  expect(geminiApiAssetCandidates(payload, "c")).toMatchObject([
    { pointer: url("voice"), messageId: "r_user", contentType: "audio/wav" },
    { pointer: url("clip"), messageId: "r_user", contentType: "video/mp4" },
    { pointer: url("paper"), messageId: "r_user", contentType: "application/pdf" },
  ]);
});

test("Gemini captures generated image, video and music fields with candidate ownership", () => {
  const rich: any[] = [];
  rich[7] = [[[[null, null, null, [null, null, "alt", url("banana")]], ["img-id"]]]];
  rich[59] = [[[[[null, null, null, null, null, null, null, [url("thumb"), url("movie")]]]]]];
  rich[86] = [[null, [null, null, null, null, null, null, null, [url("cover"), url("music")]]]];
  const payload = [[[["c_c", "r_user"], ["c_c", "r_reply", "rc_model"], [["prompt"]], [ [["rc_model", ["result"], null, null, null, null, null, null, null, null, null, null, rich]] ]]]];
  const assets = geminiApiAssetCandidates(payload, "c");
  expect(assets.map(a => a.pointer)).toEqual([url("banana"), url("movie"), url("music")]);
  expect(assets.map(a => a.messageId)).toEqual(["rc_model", "rc_model", "rc_model"]);
  expect(assets.map(a => a.contentType)).toEqual(["image/png", "video/mp4", "audio/mpeg"]);
});

test("Gemini API assets flow into capture before text is emitted", async () => {
  const payload = [[[["c_c", "r_user"], null, [["prompt"], 1, [{ type: "audio", url: url("voice"), mime_type: "audio/wav" }]], null]]];
  const originalChrome = (globalThis as any).chrome;
  (globalThis as any).chrome = { runtime: { sendMessage: (message: any, reply: any) => {
    expect(message.type).toBe("SCROBBLER_ASSET_FETCH");
    reply({ ok: true, bytes: [1, 2], contentType: "audio/wav" });
  } } };
  try {
    await createGeminiAdapter(async () => new Response(JSON.stringify([["wrb.fr", "hNvQHb", JSON.stringify(payload)]])), {
      readWizData: () => ({ at: "csrf", bl: "build", fSid: "sid" }),
      listConversationIds: () => ["c"], readConversationDom: () => null, readConversationAssets: () => [],
    }).captureOne!("c", null, {
      uploadAsset: async a => ({ pointer: a.pointer, local_path: "assets/gemini/c/hash.wav", sha256: "a".repeat(64) }),
      emitCapture: async capture => { expect(capture.assets).toMatchObject([{ message_id: "r_user", content_type: "audio/wav" }]); },
    });
  } finally { (globalThis as any).chrome = originalChrome; }
});
