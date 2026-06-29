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
  expect(s.messages[2].blocks[1]).toMatchObject({ type: "attachment", kind: "image", pointer: "file-service://file-IMG1" });
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
  expect(s.messages[2].blocks[0]).toMatchObject({ type: "tool_result", name: "code" });
  expect(s.messages[2].text).toContain("1");
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
    type: "attachment",
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
