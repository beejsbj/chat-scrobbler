// test/sqlite.test.ts
import { test, expect } from "bun:test";
import { openIndex, indexSession, searchMessages, listSessions } from "../src/indexer/sqlite";
import type { Session } from "../src/schema/types";

function mk(id: string, source: "chatgpt" | "claude", title: string, text: string): Session {
  return {
    id: `${source}:${id}`, source, source_id: id, capture_method: "export",
    title, created_at: "2025-01-01T00:00:00Z", updated_at: "2025-01-02T00:00:00Z",
    default_model: null, account: null, raw_ref: `${source}:${id}`, schema_version: 1,
    messages: [{ id: `${id}-m1`, role: "user", created_at: null, parent_id: null, model: null,
      blocks: [{ type: "text", text }], text }],
  };
}

test("search returns message-level hits matching the query", () => {
  const db = openIndex(":memory:");
  indexSession(db, mk("a", "chatgpt", "Ego talk", "ego is a protective interface"));
  indexSession(db, mk("b", "claude", "Healing", "healing is restoration of wholeness"));

  const hits = searchMessages(db, "protective");
  expect(hits).toHaveLength(1);
  expect(hits[0].session_id).toBe("chatgpt:a");
  expect(hits[0].message_id).toBe("a-m1");
  expect(hits[0].source).toBe("chatgpt");
  expect(hits[0].snippet.toLowerCase()).toContain("protective");
});

test("search filters by source", () => {
  const db = openIndex(":memory:");
  indexSession(db, mk("a", "chatgpt", "T1", "shared word here"));
  indexSession(db, mk("b", "claude", "T2", "shared word here"));
  expect(searchMessages(db, "shared", { source: "claude" })).toHaveLength(1);
});

test("listSessions returns summaries with message counts and title filter", () => {
  const db = openIndex(":memory:");
  indexSession(db, mk("a", "chatgpt", "Ego talk", "x"));
  indexSession(db, mk("b", "claude", "Healing", "y"));
  const all = listSessions(db);
  expect(all).toHaveLength(2);
  expect(all[0].message_count).toBe(1);
  expect(listSessions(db, { titleContains: "Ego" })).toHaveLength(1);
});

test("re-indexing a session does not duplicate FTS rows", () => {
  const db = openIndex(":memory:");
  const s = mk("a", "chatgpt", "T", "protection matters");
  indexSession(db, s);
  indexSession(db, s);
  expect(searchMessages(db, "protection")).toHaveLength(1);
});

test("empty or whitespace query returns [] without throwing", () => {
  const db = openIndex(":memory:");
  indexSession(db, mk("a", "chatgpt", "T", "hello"));
  expect(searchMessages(db, "")).toEqual([]);
  expect(searchMessages(db, "   ")).toEqual([]);
});
