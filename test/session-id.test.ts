// test/session-id.test.ts
import { test, expect } from "bun:test";
import { parseSessionId } from "../src/core/session-id";

test("parseSessionId parses a valid chatgpt id", () => {
  const result = parseSessionId("chatgpt:abc-123");
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.source).toBe("chatgpt");
    expect(result.sourceId).toBe("abc-123");
  }
});

test("parseSessionId parses a valid claude id", () => {
  const result = parseSessionId("claude:cl-x");
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.source).toBe("claude");
    expect(result.sourceId).toBe("cl-x");
  }
});

test("parseSessionId parses a valid gemini id with underscores", () => {
  const result = parseSessionId("gemini:abc_DEF-123");
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.source).toBe("gemini");
    expect(result.sourceId).toBe("abc_DEF-123");
  }
});

test("parseSessionId rejects id with no colon", () => {
  const result = parseSessionId("nocolon");
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("expected format");
  }
});

test("parseSessionId rejects id with colon at position 0 (empty source)", () => {
  const result = parseSessionId(":abc");
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("expected format");
  }
});

test("parseSessionId rejects unknown source", () => {
  const result = parseSessionId("unknown:abc");
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("unknown source");
  }
});

test("parseSessionId rejects unsafe source_id with path traversal", () => {
  const result = parseSessionId("chatgpt:../../etc/passwd");
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("unsafe source_id");
  }
});

test("parseSessionId rejects unsafe source_id with slash", () => {
  const result = parseSessionId("chatgpt:a/b");
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("unsafe source_id");
  }
});

test("parseSessionId rejects unsafe source_id with double dots", () => {
  const result = parseSessionId("gemini:..");
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("unsafe source_id");
  }
});
