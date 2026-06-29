// test/render.test.ts
import { test, expect } from "bun:test";
import { renderText } from "../src/parsers/render";
import type { Block } from "../src/schema/types";

test("renders text, reasoning, artifact, attachment, tool blocks", () => {
  const blocks: Block[] = [
    { type: "text", text: "hello world" },
    { type: "reasoning", text: "thinking step" },
    { type: "artifact", artifact_id: "a1", kind: "code", title: "My Art", version: null, content: "console.log(1)" },
    { type: "tool_call", name: "search", input: { q: "x" } },
    { type: "tool_result", name: "search", output: "found it" },
    { type: "attachment", kind: "image", filename: "pic.png", pointer: "file-x", local_path: null },
  ];
  const out = renderText(blocks);
  expect(out).toContain("hello world");
  expect(out).toContain("thinking step");
  expect(out).toContain("My Art");
  expect(out).toContain("console.log(1)");
  expect(out).toContain("found it");
  expect(out).toContain("[image: pic.png]");
});

test("empty blocks render to empty string", () => {
  expect(renderText([])).toBe("");
});

test("tool_result with null output is skipped", () => {
  expect(renderText([{ type: "tool_result", name: "x", output: null }])).toBe("");
});

test("attachment with null filename omits the colon", () => {
  expect(renderText([{ type: "attachment", kind: "image", filename: null, pointer: "p", local_path: null }])).toBe("[image]");
});

test("attachment with local_path renders a canonical-relative asset link hint", () => {
  expect(renderText([{
    type: "attachment",
    kind: "image",
    filename: "pic.png",
    pointer: "p",
    local_path: "assets/chatgpt/conv/hash.png",
  }])).toBe("[image: pic.png -> assets/chatgpt/conv/hash.png]");
});
