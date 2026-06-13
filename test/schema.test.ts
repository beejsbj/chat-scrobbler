// test/schema.test.ts
import { test, expect } from "bun:test";
import { makeSessionId } from "../src/schema/types";

test("makeSessionId namespaces by source", () => {
  expect(makeSessionId("chatgpt", "abc-123")).toBe("chatgpt:abc-123");
  expect(makeSessionId("claude", "uuid-9")).toBe("claude:uuid-9");
});
