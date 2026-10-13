import { expect, test } from "bun:test";
import { createClaudeAdapter } from "../packages/extension/src/providers/claude";

test("Claude captures generated files, inline visuals and downloadable sandbox files", async () => {
  const uploads: any[] = [];
  const payload = { uuid: "c", chat_messages: [{ uuid: "m", sender: "assistant",
    generated_files: [{ file_uuid: "gen-1", file_name: "slides.pptx", download_url: "/api/generated/slides" }],
    content: [{ type: "tool_result", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
      { type: "file", file_uuid: "visual", url: "/api/generated/visual", mime_type: "image/svg+xml" },
    ] }, { type: "text", text: "[PDF](sandbox:/mnt/user-data/outputs/report.pdf)" }],
  }] };
  await createClaudeAdapter(async input => {
    if (input === "/api/organizations") return Response.json([{ uuid: "org" }]);
    if (input.startsWith("/api/organizations/org/chat_conversations/c?")) return Response.json(payload);
    if (input.startsWith("data:")) return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
    if (input.startsWith("/api/generated") || input.includes("wiggle/download-file")) return new Response(new Uint8Array([4, 5, 6]));
    throw new Error(`unexpected ${input}`);
  }).captureOne!("c", null, { uploadAsset: async asset => {
    uploads.push(asset); return { pointer: asset.pointer, local_path: "assets/claude/c/hash" };
  }, emitCapture: async capture => { expect(capture.assets).toHaveLength(4); } });
  expect(uploads.map(a => a.pointer)).toEqual(["gen-1", "claude-inline:m:/content/0/content/0", "visual", "sandbox:/mnt/user-data/outputs/report.pdf"]);
  expect(uploads.every(a => a.messageId === "m")).toBe(true);
  expect(Array.from(uploads[1].bytes)).toEqual([1, 2, 3]);
});
