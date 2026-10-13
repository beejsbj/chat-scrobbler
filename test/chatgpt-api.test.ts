// test/chatgpt-api.test.ts
import { test, expect } from "bun:test";
import { parseChatgpt } from "../src/parsers/chatgpt";
import sample from "./fixtures/chatgpt-api-sample.json";

test("parses a chatgpt API capture (RawCapture envelope) into a canonical session", () => {
  const [s] = parseChatgpt(sample);
  expect(s.id).toBe("chatgpt:conv-1");
  expect(s.source).toBe("chatgpt");
  expect(s.capture_method).toBe("api");
  expect(s.title).toBe("Ego and Identity");
  expect(s.created_at).toBe(new Date(1700000000_000).toISOString());
  expect(s.messages).toHaveLength(3);
  expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
  // thoughts -> reasoning (shared block shape)
  expect(s.messages[1].blocks[0]).toMatchObject({ type: "reasoning", text: "Consider self-protection." });
  // multimodal: text + image attachment
  expect(s.messages[2].blocks[0]).toMatchObject({ type: "text", text: "Ego is a protective interface." });
  expect(s.messages[2].blocks[1]).toMatchObject({ type: "image", pointer: "file-service://file-IMG1" });
});

test("handles API-only system/tool roles and code/execution_output content", () => {
  const payload = {
    conversation_id: "conv-tools",
    title: "Tools",
    create_time: 1700000000.0,
    update_time: 1700000010.0,
    current_node: "t3",
    mapping: {
      root: { id: "root", message: null, parent: null, children: ["t1"] },
      t1: { id: "t1", message: { id: "t1", author: { role: "user" }, content: { content_type: "text", parts: ["run it"] }, metadata: {} }, parent: "root", children: ["t2"] },
      t2: { id: "t2", message: { id: "t2", author: { role: "assistant" }, content: { content_type: "code", language: "python", text: "print(1)" }, metadata: {} }, parent: "t1", children: ["t3"] },
      t3: { id: "t3", message: { id: "t3", author: { role: "tool" }, content: { content_type: "execution_output", text: "1" }, metadata: {} }, parent: "t2", children: [] },
    },
  };
  const capture = {
    source: "chatgpt", capture_method: "api", schema_version: 1,
    fetched_at: "2026-06-05T10:00:00.000Z", source_id: "conv-tools",
    endpoint: "/backend-api/conversation/conv-tools", payload,
  };
  const [s] = parseChatgpt(capture);
  expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
  expect(s.messages[1].blocks[0]).toMatchObject({ type: "tool_call", name: "code" });
  expect(s.messages[2].blocks[0]).toMatchObject({ type: "tool_call", name: "code" });
  expect(s.messages[2].text).not.toContain("1");
});

test("hydrates ChatGPT attachment local_path from uploaded asset sidecar", () => {
  const capture = {
    ...sample,
    assets: [{
      pointer: "file-service://file-IMG1",
      local_path: "assets/chatgpt/conv-1/hash.png",
      filename: "hash.png",
      content_type: "image/png",
      size_bytes: 3,
      sha256: "hash",
    }],
  };
  const [s] = parseChatgpt(capture);
  expect(s.messages[2].blocks[1]).toMatchObject({
    type: "image",
    pointer: "file-service://file-IMG1",
    local_path: "assets/chatgpt/conv-1/hash.png",
  });
  expect(s.messages[2].text).toContain("assets/chatgpt/conv-1/hash.png");
});

test("returns [] for empty or malformed input", () => {
  expect(parseChatgpt(null)).toEqual([]);
  expect(parseChatgpt({})).toEqual([]);
  expect(parseChatgpt({ payload: {} })).toEqual([]);
});

test("retains every unrecognized ChatGPT part and caps its inline JSON in UTF-8 bytes", () => {
  const capture = structuredClone(sample) as any;
  const parts = capture.payload.mapping.n3.message.content.parts;
  parts.push({ content_type: "intelligent_ui", specification: { chart: [1, 2] } });
  parts.push({ content_type: "future_large", data: "界".repeat(17000) });
  const [s] = parseChatgpt(capture, { raw_ref: "chatgpt/conv-1/version.json.gz" });
  const unknowns = s.messages[2].blocks.filter(b => b.type === "unknown");
  expect(unknowns).toHaveLength(2);
  expect(unknowns[0]).toMatchObject({ provider_type: "intelligent_ui", raw_json: parts[2], truncated: false,
    raw_ref: "chatgpt/conv-1/version.json.gz", raw_path: "/payload/mapping/n3/message/content/parts/2" });
  expect(unknowns[1]).toMatchObject({ provider_type: "future_large", raw_json: null, truncated: true });
  expect(unknowns[1].size_bytes).toBeGreaterThan(50000);
  expect(s.messages[2].text).not.toContain("chart:");
});

test("classifies recipients and tool replies without storing their inputs or outputs", () => {
  for (const [recipient, family] of [["image_gen.text2im", "image_gen"], ["web.run", "browsing"], ["python", "python"]]) {
    const capture = structuredClone(sample) as any;
    const message = capture.payload.mapping.n3.message;
    message.recipient = recipient;
    message.content = { content_type: "code", text: "tool-input-noise" };
    const [s] = parseChatgpt(capture);
    expect(s.messages[2].blocks).toEqual([{ type: "tool_call", name: recipient, tool_type: family }]);
    expect(s.messages[2].text).not.toContain("tool-input-noise");
    message.author = { role: "tool", name: recipient };
    message.recipient = "all";
    message.content = { content_type: "text", parts: ["tool-output-noise"] };
    const [reply] = parseChatgpt(capture);
    expect(reply.messages[2].blocks).toEqual([{ type: "tool_call", name: recipient, tool_type: family }]);
    expect(reply.messages[2].text).not.toContain("tool-output-noise");
  }
});

test("keeps undocumented references and unknown content even when it has string parts", () => {
  const capture = structuredClone(sample) as any;
  const message = capture.payload.mapping.n3.message;
  message.content = { content_type: "new_visual", parts: ["caption", { data: 42 }] };
  message.metadata.content_references = [{ type: "new_reference", url: "https://example.org" }];
  message.metadata.citations = [{ source: "paper" }];
  const [s] = parseChatgpt(capture);
  expect(s.schema_version).toBe(2);
  expect(s.messages[2].blocks.map(b => b.type)).toEqual(["text", "unknown", "unknown", "unknown"]);
  expect(s.messages[2].blocks[1]).toMatchObject({ raw_json: message.content });
});

test("unknown content in disconnected mapping nodes survives with an escaped raw pointer", () => {
  const capture = structuredClone(sample) as any;
  capture.payload.mapping["orphan/key~1"] = { id: "orphan/key~1", parent: null, children: [], message: {
    id: "orphan-message", author: { role: "assistant" }, content: { content_type: "new_visual", data: 42 },
  } };
  const [s] = parseChatgpt(capture, { raw_ref: "version" });
  const orphan = s.messages.find(m => m.id === "orphan-message");
  expect(orphan?.blocks[0]).toMatchObject({ type: "unknown", raw_ref: "version", raw_path: "/payload/mapping/orphan~1key~01/message/content" });
});

test("unfamiliar tool names stay string labels without being confused with known families", () => {
  const capture = structuredClone(sample) as any;
  capture.payload.mapping.n3.message.recipient = "constructor.run";
  expect(parseChatgpt(capture)[0].messages[2].blocks[0]).toEqual({ type: "tool_call", name: "constructor.run", tool_type: "constructor" });
});

test("preserves unfamiliar non-array reference containers instead of dropping them", () => {
  const capture = structuredClone(sample) as any;
  capture.payload.mapping.n3.message.metadata.content_references = { type: "future_reference_container", entries: [{ opaque: true }] };
  const [s] = parseChatgpt(capture);
  expect(s.messages[2].blocks).toContainEqual(expect.objectContaining({ type: "unknown", provider_type: "future_reference_container", raw_json: capture.payload.mapping.n3.message.metadata.content_references }));
});

test("tool-role and recipient messages retain hydrated media and opaque parts without tool prose", () => {
  for (const toolRole of [true, false]) {
    const capture = structuredClone(sample) as any;
    const message = capture.payload.mapping.n3.message;
    message.author = toolRole ? { role: "tool", name: "dalle.text2im" } : { role: "assistant" };
    message.recipient = toolRole ? "all" : "dalle.text2im";
    message.content.parts[0] = "tool prose noise";
    message.content.parts.push({ content_type: "new_image_metadata", data: { opaque: true } });
    capture.assets = [{ pointer: "file-service://file-IMG1", sha256: "a".repeat(64), local_path: "assets/chatgpt/conv-1/image.png" }];
    const msg = parseChatgpt(capture)[0].messages[2];
    expect(msg.blocks[0]).toEqual({ type: "tool_call", name: "dalle.text2im", tool_type: "image_gen" });
    expect(msg.blocks).toContainEqual(expect.objectContaining({ type: "image", pointer: "file-service://file-IMG1", sha256: "a".repeat(64), local_path: "assets/chatgpt/conv-1/image.png" }));
    expect(msg.blocks).toContainEqual(expect.objectContaining({ type: "unknown", provider_type: "new_image_metadata" }));
    expect(msg.text).toContain("[image");
    expect(msg.text).not.toContain("tool prose noise");
  }
});

test("unfamiliar ChatGPT content keeps searchable prose and its original unknown fragment", () => {
  const capture = structuredClone(sample) as any;
  const message = capture.payload.mapping.n3.message;
  message.content = { content_type: "tether_quote", text: "quoted prose here", parts: ["first line", { type: "future", data: 42 }, "second line"] };
  const parsed = parseChatgpt(capture)[0].messages[2];
  expect(parsed.text).toContain("quoted prose here");
  expect(parsed.text).toContain("first line\nsecond line");
  expect(parsed.blocks).toContainEqual(expect.objectContaining({ type: "unknown", provider_type: "tether_quote", raw_json: message.content }));
  message.author = { role: "tool", name: "web.run" };
  const tool = parseChatgpt(capture)[0].messages[2];
  expect(tool.text).not.toContain("quoted prose here");
  expect(tool.text).not.toContain("first line");
});

test("ordinary ChatGPT multipart text keeps single newline separators alongside opaque parts", () => {
  const capture = structuredClone(sample) as any;
  capture.payload.mapping.n3.message.content = { content_type: "text", parts: ["first line", { type: "future", data: 42 }, "second line"] };
  const message = parseChatgpt(capture)[0].messages[2];
  expect(message.text).toBe("first line\nsecond line");
  expect(message.blocks.filter((b: any) => b.type === "unknown")).toHaveLength(1);
});
