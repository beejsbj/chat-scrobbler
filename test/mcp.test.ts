// test/mcp.test.ts
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer, handleGetSession, handleSearch } from "../src/mcp/server";
import { writeSession } from "../src/store/sessions";
import { openIndex, indexSession } from "../src/indexer/sqlite";
import type { Session } from "../src/schema/types";

test("buildServer constructs and registers the three read tools", () => {
  const server = buildServer({ indexPath: ":memory:", canonicalDir: "/tmp/does-not-matter" });
  // McpServer exposes registered tools on its internal registry
  const tools = (server as any)._registeredTools ?? {};
  const names = Object.keys(tools);
  expect(names).toContain("search");
  expect(names).toContain("get_session");
  expect(names).toContain("list_sessions");
});

test("handleGetSession returns a written session by id", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-canon-"));
  const s: Session = {
    id: "claude:cl-x", source: "claude", source_id: "cl-x", capture_method: "export",
    title: "Hello", created_at: "2025-01-01T00:00:00.000Z", updated_at: "2025-01-01T00:00:00.000Z",
    default_model: null, account: null, raw_ref: "claude-chats:cl-x", schema_version: 1,
    messages: [{ id: "m1", role: "user", created_at: null, parent_id: null, model: null, blocks: [{ type: "text", text: "hi there" }], text: "hi there" }],
  };
  writeSession(dir, s);
  const res = handleGetSession(dir, { id: "claude:cl-x" });
  expect(res.isError).toBeFalsy();
  expect(res.content[0].text).toContain("Hello");
  rmSync(dir, { recursive: true, force: true });
});

test("handleGetSession rejects malformed and path-traversal ids", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-canon-"));
  for (const bad of ["chatgpt:../../../../etc/passwd", "x:../../package", "nocolon", ":empty", "chatgpt:a/b", "chatgpt:.."]) {
    const res = handleGetSession(dir, { id: bad });
    expect(res.isError).toBe(true);
    expect(res.content[0].text.toLowerCase()).toContain("invalid session id");
  }
  rmSync(dir, { recursive: true, force: true });
});

test("handleSearch returns message hits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-idx-"));
  const db = openIndex(join(dir, "i.db"));
  indexSession(db, {
    id: "chatgpt:a", source: "chatgpt", source_id: "a", capture_method: "export",
    title: "T", created_at: "2025-01-01T00:00:00.000Z", updated_at: "2025-01-01T00:00:00.000Z",
    default_model: null, account: null, raw_ref: "x", schema_version: 1,
    messages: [{ id: "a-m1", role: "user", created_at: null, parent_id: null, model: null, blocks: [{ type: "text", text: "uniquetokenxyz" }], text: "uniquetokenxyz" }],
  });
  const res = await handleSearch(db, { query: "uniquetokenxyz" });
  expect(res.content[0].text).toContain("chatgpt:a");
  const hits = JSON.parse(res.content[0].text);
  expect(hits[0].match_sources).toEqual(["literal"]);
  expect(hits[0].score).toBeGreaterThan(0);
  rmSync(dir, { recursive: true, force: true });
});
