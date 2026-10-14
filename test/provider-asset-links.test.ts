import { test, expect } from "bun:test";
import { parseChatgpt } from "../src/parsers/chatgpt";
import { parseClaude } from "../src/parsers/claude";
import { parseGemini } from "../src/parsers/gemini";

const asset = (pointer: string, local: string, extra: Record<string, unknown> = {}) =>
  ({ pointer, local_path: local, sha256: local.slice(-6), ...extra });

const media = (blocks: any[]) => blocks.filter(b => ["image", "audio", "video", "file"].includes(b.type));

function gpt(messages: Array<{ id: string; role: string; content: any; metadata?: any; recipient?: string; author?: any }>, assets: any[]) {
  const mapping: Record<string, any> = { root: { id: "root", message: null, parent: null, children: [messages[0].id] } };
  messages.forEach((m, i) => {
    mapping[m.id] = { id: m.id, parent: i === 0 ? "root" : messages[i - 1].id,
      children: messages[i + 1] ? [messages[i + 1].id] : [],
      message: { id: m.id, author: m.author ?? { role: m.role }, create_time: 1, recipient: m.recipient ?? "all",
        content: m.content, metadata: m.metadata ?? {} } };
  });
  return { source: "chatgpt", source_id: "c1", payload: { conversation_id: "c1", current_node: messages.at(-1)!.id, mapping }, assets };
}

test("ChatGPT links metadata attachments by file id and keeps the opaque entry", () => {
  const [s] = parseChatgpt(gpt([{ id: "u1", role: "user", content: { content_type: "text", parts: ["see file"] },
    metadata: { attachments: [{ id: "file-DOC1", name: "report.pdf", mime_type: "application/pdf" }] } }],
    [asset("file-service://file-DOC1", "assets/chatgpt/c1/doc111.pdf", { content_type: "application/pdf", filename: "report.pdf" })]));
  const files = media(s.messages[0].blocks);
  expect(files).toEqual([expect.objectContaining({ type: "file", pointer: "file-service://file-DOC1",
    local_path: "assets/chatgpt/c1/doc111.pdf", mime_type: "application/pdf" })]);
  expect(s.messages[0].blocks.some(b => b.type === "unknown" && b.provider_type === "attachments")).toBe(true);
});

test("ChatGPT links assets by message_id once, even for a media-only tool message", () => {
  const [s] = parseChatgpt(gpt([
    { id: "u1", role: "user", content: { content_type: "text", parts: ["plot it"] } },
    { id: "t1", role: "tool", author: { role: "tool", name: "python" }, content: { content_type: "execution_output", text: "" },
      metadata: { aggregate_result: { messages: [{ message_type: "image", image_url: "file-service://file-PLOT" }] } } },
    { id: "t2", role: "tool", author: { role: "tool", name: "dalle.text2im" }, content: { content_type: "text", parts: [""] } },
  ], [
    asset("file-service://file-PLOT", "assets/chatgpt/c1/plot111.png", { message_id: "t1", content_type: "image/png" }),
    asset("sediment://file_GEN", "assets/chatgpt/c1/gen111.webp", { message_id: "t2", content_type: "image/webp" }),
  ]));
  expect(media(s.messages.find(m => m.id === "t1")!.blocks)).toHaveLength(1);
  expect(media(s.messages.find(m => m.id === "t2")!.blocks)).toEqual([
    expect.objectContaining({ type: "image", pointer: "sediment://file_GEN", local_path: "assets/chatgpt/c1/gen111.webp" })]);
});

test("ChatGPT voice parts link audio and video container pointers without duplicating", () => {
  const [s] = parseChatgpt(gpt([{ id: "u1", role: "user", content: { content_type: "multimodal_text", parts: [
    { content_type: "audio_transcription", text: "hello there" },
    { content_type: "audio_asset_pointer", asset_pointer: "file-service://file-VOICE", format: "wav" },
    { content_type: "real_time_user_audio_video_asset_pointer", audio_asset_pointer: { asset_pointer: "file-service://file-RT" },
      video_container_asset_pointer: { asset_pointer: "file-service://file-VID" } },
  ] } }], [
    asset("file-service://file-VOICE", "assets/chatgpt/c1/voice11.wav", { message_id: "u1", content_type: "audio/wav" }),
    asset("file-service://file-RT", "assets/chatgpt/c1/rt1111.wav", { message_id: "u1", content_type: "audio/wav" }),
    asset("file-service://file-VID", "assets/chatgpt/c1/vid111.mp4", { message_id: "u1", content_type: "video/mp4" }),
  ]));
  const m = media(s.messages[0].blocks);
  expect(m.map(b => [b.type, b.local_path])).toEqual([
    ["audio", "assets/chatgpt/c1/voice11.wav"], ["audio", "assets/chatgpt/c1/rt1111.wav"], ["video", "assets/chatgpt/c1/vid111.mp4"]]);
  expect(s.messages[0].blocks.some(b => b.type === "unknown")).toBe(false);
});

test("ChatGPT keeps unmatched in-content pointers with null local_path", () => {
  const [s] = parseChatgpt(gpt([{ id: "u1", role: "user", content: { content_type: "multimodal_text", parts: [
    { content_type: "image_asset_pointer", asset_pointer: "file-service://file-GONE" }] } }], []));
  expect(media(s.messages[0].blocks)).toEqual([expect.objectContaining({ pointer: "file-service://file-GONE", local_path: null })]);
});

const claudeCapture = (msgs: any[], assets: any[]) => ({ source: "claude", source_id: "cl1", account: "org",
  payload: { uuid: "cl1", name: "t", chat_messages: msgs }, assets });

test("Claude links generated_files, files_v2 and nested tool_result visuals", () => {
  const [s] = parseClaude(claudeCapture([
    { uuid: "h1", sender: "human", text: "make a chart", content: [{ type: "text", text: "make a chart" }] },
    { uuid: "a1", sender: "assistant", parent_message_uuid: "h1", content: [
      { type: "text", text: "Here you go" },
      { type: "tool_result", name: "bash_tool", content: [
        { type: "image", source: { type: "file", file_uuid: "img-uuid-1", media_type: "image/png" } },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] }],
      generated_files: [{ file_uuid: "gen-uuid-1", file_name: "out.csv", mime_type: "text/csv" }],
      files_v2: [{ file_uuid: "v2-uuid-1", file_name: "in.png", file_kind: "image" }] },
  ], [
    asset("gen-uuid-1", "assets/claude/cl1/gen111.csv", { content_type: "text/csv" }),
    asset("img-uuid-1", "assets/claude/cl1/img111.png", { content_type: "image/png" }),
    asset("v2-uuid-1", "assets/claude/cl1/v21111.png", { content_type: "image/png" }),
    asset("claude-blob-bin", "assets/claude/cl1/bin111.png", { message_id: "a1", content_type: "image/png" }),
  ]));
  const m = media(s.messages[1].blocks).map((b: any) => [b.type, b.pointer, b.local_path]);
  expect(m).toContainEqual(["file", "gen-uuid-1", "assets/claude/cl1/gen111.csv"]);
  expect(m).toContainEqual(["image", "img-uuid-1", "assets/claude/cl1/img111.png"]);
  expect(m).toContainEqual(["image", "v2-uuid-1", "assets/claude/cl1/v21111.png"]);
  expect(m).toContainEqual(["image", "claude-blob-bin", "assets/claude/cl1/bin111.png"]);
  expect(m).toHaveLength(4);
});

test("Claude keeps a media-only message that has only a captured asset", () => {
  const [s] = parseClaude(claudeCapture([
    { uuid: "h1", sender: "human", content: [], text: "" },
  ], [asset("up-1", "assets/claude/cl1/up1111.png", { message_id: "h1", content_type: "image/png" })]));
  expect(s.messages).toHaveLength(1);
  expect(media(s.messages[0].blocks)).toHaveLength(1);
});

const turn = (user: string[] | null, rc: Array<[string, string[] | null]>) => [
  ["c_g1", "r_user"], ["c_g1", "r_resp", rc[0][0]], [user, 2, null, 1, "hex", 1, null, null, false],
  [rc.map(([id, parts]) => [id, parts]), null, null, rc[0][0]], [1760000000, 0]];

const gemCapture = (turns: any[], assets: any[]) => ({ source: "gemini", source_id: "g1",
  fetched_at: "2026-06-06T00:00:00.000Z", payload: [turns, null, null, []], assets });

test("Gemini places uploads and outputs by message_id without duplicates", () => {
  const [s] = parseGemini(gemCapture([turn(["look at this"], [["rc_1", ["nice picture"]]])], [
    asset("blob:up", "assets/gemini/g1/up1111.png", { message_id: "r_user", content_type: "image/png" }),
    asset("blob:out", "assets/gemini/g1/out111.png", { message_id: "rc_1", content_type: "image/png" }),
    asset("blob:out", "assets/gemini/g1/out111.png", { message_id: "rc_1", content_type: "image/png" }),
  ]));
  expect(media(s.messages[0].blocks).map((b: any) => b.pointer)).toEqual(["blob:up"]);
  expect(media(s.messages[1].blocks).map((b: any) => b.pointer)).toEqual(["blob:out"]);
});

test("Gemini keeps media-only user and candidate messages and falls back to the tip", () => {
  const [s] = parseGemini(gemCapture([turn(null, [["rc_1", null]])], [
    asset("blob:up", "assets/gemini/g1/up1111.png", { message_id: "r_user", content_type: "image/png" }),
    asset("blob:gen", "assets/gemini/g1/gen111.png", { message_id: "rc_1", content_type: "image/png" }),
    asset("blob:lost", "assets/gemini/g1/los111.mp4", { content_type: "video/mp4" }),
  ]));
  expect(s.messages.map(m => m.id)).toEqual(["r_user", "rc_1"]);
  expect(s.messages[0].parent_id).toBeNull();
  expect(s.messages[1].parent_id).toBe("r_user");
  expect(media(s.messages[1].blocks).map((b: any) => b.pointer)).toEqual(["blob:gen", "blob:lost"]);
  expect(s.active_leaf_id).toBe("rc_1");
});

test("ChatGPT keeps a retryable file block when upload metadata has no captured bytes", () => {
  const session = parseChatgpt({ payload: { id: "c", mapping: { n: { id: "n", parent: null, message: {
    id: "m", author: { role: "user" }, content: { content_type: "text", parts: ["read this"] },
    metadata: { attachments: [{ id: "file_doc", name: "paper.pdf", mime_type: "application/pdf" }] },
  } } } } })[0];
  expect(session.messages[0].blocks).toContainEqual({ type: "file", pointer: "file_doc", filename: "paper.pdf", local_path: null, sha256: null, mime_type: "application/pdf" });
});

test("ChatGPT keeps root voice audio and sandbox download pointers before bytes arrive", () => {
  const session = parseChatgpt({ payload: { id: "c", mapping: {
    voice: { id: "voice", parent: null, message: { id: "v", author: { role: "user" }, content: { content_type: "audio_asset_pointer", audio_asset_pointer: "sediment://voice" } } },
    output: { id: "output", parent: "voice", message: { id: "o", author: { role: "assistant" }, content: { content_type: "text", parts: ["[Download](sandbox:/mnt/data/report.csv)"] } } },
  } } })[0];
  expect(session.messages[0].blocks).toMatchObject([{ type: "audio", pointer: "sediment://voice", local_path: null }]);
  expect(session.messages[1].blocks).toContainEqual({ type: "file", pointer: "sandbox:/mnt/data/report.csv", filename: "report.csv", local_path: null, sha256: null, mime_type: null });
});

test("Gemini retains failed API media references for a later canonical backfill", () => {
  const session = parseGemini({ source_id: "c", payload: [[[["c_c", "r_user"], null, [[], 1], null]]],
    assets: [], asset_references: [{ pointer: "https://lh3.googleusercontent.com/voice", message_id: "r_user", filename: "voice.wav", content_type: "audio/wav" }],
  })[0];
  expect(session.messages[0]?.blocks).toContainEqual({ type: "audio", pointer: "https://lh3.googleusercontent.com/voice", filename: "voice.wav", local_path: null, sha256: null, mime_type: "audio/wav" });
});

const SANDBOX = "sandbox:/mnt/data/plot.png";
const plot = (id: string, local: string, sha256: string) =>
  asset(SANDBOX, local, { message_id: id, sha256, content_type: "image/png" });
const hashes = (blocks: any[]) => media(blocks).map(b => [b.local_path, b.sha256]);

test("ChatGPT links a reused sandbox path to each message's own bytes", () => {
  const [s] = parseChatgpt(gpt([
    { id: "a1", role: "assistant", content: { content_type: "text", parts: [`[plot](${SANDBOX})`] } },
    { id: "a2", role: "assistant", content: { content_type: "text", parts: [`[plot](${SANDBOX})`] } },
    { id: "a3", role: "assistant", content: { content_type: "text", parts: ["no file here"] } },
  ], [plot("a1", "assets/chatgpt/c1/one.png", "hash-one"), plot("a2", "assets/chatgpt/c1/two.png", "hash-two")]));
  expect(hashes(s.messages[0].blocks)).toEqual([["assets/chatgpt/c1/one.png", "hash-one"]]);
  expect(hashes(s.messages[1].blocks)).toEqual([["assets/chatgpt/c1/two.png", "hash-two"]]);
  expect(media(s.messages[2].blocks)).toEqual([]);
});

test("ChatGPT appended references stay message-scoped and an unmatched message gets no foreign hash", () => {
  const [s] = parseChatgpt(gpt([
    { id: "a1", role: "assistant", content: { content_type: "text", parts: ["one"] } },
    { id: "a2", role: "assistant", content: { content_type: "text", parts: ["two"] } },
    { id: "a3", role: "assistant", content: { content_type: "text", parts: [`[plot](${SANDBOX})`] } },
  ], [plot("a1", "assets/chatgpt/c1/one.png", "hash-one"), plot("a2", "assets/chatgpt/c1/two.png", "hash-two")]));
  expect(hashes(s.messages[0].blocks)).toEqual([["assets/chatgpt/c1/one.png", "hash-one"]]);
  expect(hashes(s.messages[1].blocks)).toEqual([["assets/chatgpt/c1/two.png", "hash-two"]]);
  expect(hashes(s.messages[2].blocks)).toEqual([[null, null]]);
});

test("ChatGPT pointer-only fallback applies only to legacy assets without message_id", () => {
  const [s] = parseChatgpt(gpt([
    { id: "a1", role: "assistant", content: { content_type: "text", parts: [`[plot](${SANDBOX})`] } },
  ], [asset(SANDBOX, "assets/chatgpt/c1/legacy.png", { sha256: "hash-legacy" })]));
  expect(hashes(s.messages[0].blocks)).toEqual([["assets/chatgpt/c1/legacy.png", "hash-legacy"]]);
});

test("Claude appended references with a reused pointer keep per-message bytes", () => {
  const [s] = parseClaude(claudeCapture([
    { uuid: "h1", sender: "human", text: "a", content: [{ type: "text", text: "a" }] },
    { uuid: "a1", sender: "assistant", parent_message_uuid: "h1", content: [{ type: "text", text: "b" }] },
    { uuid: "a2", sender: "assistant", parent_message_uuid: "a1", content: [{ type: "text", text: "c" }] },
  ], [plot("a1", "assets/claude/cl1/one.png", "hash-one"), plot("a2", "assets/claude/cl1/two.png", "hash-two")]));
  expect(media(s.messages[0].blocks)).toEqual([]);
  expect(hashes(s.messages[1].blocks)).toEqual([["assets/claude/cl1/one.png", "hash-one"]]);
  expect(hashes(s.messages[2].blocks)).toEqual([["assets/claude/cl1/two.png", "hash-two"]]);
});

test("Gemini appended references with a reused pointer keep per-message bytes", () => {
  const [s] = parseGemini({ source_id: "c", payload: [[[["c_c", "r_u1"], null, [[], 1], null], [["c_c", "r_u2"], null, [[], 1], null]]],
    assets: [plot("r_u1", "assets/gemini/c/one.png", "hash-one"), plot("r_u2", "assets/gemini/c/two.png", "hash-two")] });
  expect(hashes(s.messages[0].blocks)).toEqual([["assets/gemini/c/one.png", "hash-one"]]);
  expect(hashes(s.messages[1].blocks)).toEqual([["assets/gemini/c/two.png", "hash-two"]]);
});

test("Unmatched message references keep their pointer without borrowing another message's bytes", () => {
  const [s] = parseGemini({ source_id: "c", payload: [[[["c_c", "r_u1"], null, [[], 1], null], [["c_c", "r_u2"], null, [[], 1], null]]],
    assets: [plot("r_u1", "assets/gemini/c/one.png", "hash-one"), asset("blob:other", "assets/gemini/c/other.png", { message_id: "r_u2" })],
    asset_references: [{ pointer: SANDBOX, message_id: "r_gone", filename: null, content_type: "image/png" }] });
  expect(hashes(s.messages[0].blocks)).toEqual([["assets/gemini/c/one.png", "hash-one"]]);
  expect(s.messages[1].blocks.filter(b => (b as any).pointer === SANDBOX).map(b => [(b as any).local_path, (b as any).sha256])).toEqual([[null, null]]);
});
