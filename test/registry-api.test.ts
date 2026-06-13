// test/registry-api.test.ts
import { test, expect } from "bun:test";
import { getParser } from "../src/parsers/registry";
import { parseChatgpt } from "../src/parsers/chatgpt";
import { parseClaude } from "../src/parsers/claude";
import { parseGemini } from "../src/parsers/gemini";

test("routes chatgpt:api to parseChatgpt", () => {
  expect(getParser("chatgpt", "api")).toBe(parseChatgpt);
});

test("routes claude:api to parseClaude", () => {
  expect(getParser("claude", "api")).toBe(parseClaude);
});

test("routes gemini:api to parseGemini", () => {
  expect(getParser("gemini", "api")).toBe(parseGemini);
});

test("throws for removed export entries", () => {
  expect(() => getParser("chatgpt", "export")).toThrow("No parser registered for chatgpt:export");
  expect(() => getParser("claude", "export")).toThrow("No parser registered for claude:export");
});
