// test/store.test.ts
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSession, readSession, listSessionFiles, sessionToMarkdown } from "../src/store/sessions";
import type { Session } from "../src/schema/types";

const dir = mkdtempSync(join(tmpdir(), "sess-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const session: Session = {
  id: "claude:cl-1", source: "claude", source_id: "cl-1", capture_method: "export",
  title: "Healing", created_at: "2025-01-01T00:00:00Z", updated_at: "2025-01-01T00:10:00Z",
  default_model: null, account: "acct-9", raw_ref: "claude-chats:cl-1", schema_version: 1,
  messages: [{ id: "m1", role: "user", created_at: null, parent_id: null, model: null,
    blocks: [{ type: "text", text: "What is healing?" }], text: "What is healing?" }],
};

test("write then read round-trips a session", () => {
  writeSession(dir, session);
  const back = readSession(dir, "claude", "cl-1");
  expect(back).toEqual(session);
});

test("listSessionFiles finds written files", () => {
  const files = listSessionFiles(dir);
  expect(files.some(f => f.endsWith("cl-1.json"))).toBe(true);
});

test("sessionToMarkdown includes title and message text", () => {
  const md = sessionToMarkdown(session);
  expect(md).toContain("# Healing");
  expect(md).toContain("What is healing?");
});
