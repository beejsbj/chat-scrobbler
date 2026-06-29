// test/reindex.test.ts
// Verifies that runUnify reads canonical session files and makes them searchable.
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUnify } from "../src/cli/unify";
import { writeSession } from "../src/store/sessions";
import { openIndex, searchMessages } from "../src/indexer/sqlite";
import { makeSessionId, type Session } from "../src/schema/types";

const root = mkdtempSync(join(tmpdir(), "reindex-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const canonicalDir = join(root, "canonical", "sessions");
const indexPath = join(root, "index", "sessions.db");

const sessionA: Session = {
  id: makeSessionId("chatgpt", "reindex-a"),
  source: "chatgpt",
  source_id: "reindex-a",
  capture_method: "api",
  title: "Reindex Test A",
  created_at: "2025-06-01T10:00:00.000Z",
  updated_at: "2025-06-01T10:01:00.000Z",
  default_model: null,
  account: null,
  messages: [
    {
      id: "ra-m1",
      role: "user",
      created_at: "2025-06-01T10:00:01.000Z",
      parent_id: null,
      model: null,
      blocks: [{ type: "text", text: "What is photosynthesis?" }],
      text: "What is photosynthesis?",
    },
    {
      id: "ra-m2",
      role: "assistant",
      created_at: "2025-06-01T10:00:05.000Z",
      parent_id: "ra-m1",
      model: null,
      blocks: [{ type: "text", text: "Photosynthesis converts sunlight into glucose." }],
      text: "Photosynthesis converts sunlight into glucose.",
    },
  ],
  raw_ref: "raw/api/chatgpt:reindex-a",
  schema_version: 1,
};

const sessionB: Session = {
  id: makeSessionId("claude", "reindex-b"),
  source: "claude",
  source_id: "reindex-b",
  capture_method: "api",
  title: "Reindex Test B",
  created_at: "2025-06-01T11:00:00.000Z",
  updated_at: "2025-06-01T11:01:00.000Z",
  default_model: null,
  account: null,
  messages: [
    {
      id: "rb-m1",
      role: "user",
      created_at: "2025-06-01T11:00:01.000Z",
      parent_id: null,
      model: null,
      blocks: [{ type: "text", text: "Explain mitochondria." }],
      text: "Explain mitochondria.",
    },
    {
      id: "rb-m2",
      role: "assistant",
      created_at: "2025-06-01T11:00:05.000Z",
      parent_id: "rb-m1",
      model: null,
      blocks: [{ type: "text", text: "Mitochondria are the powerhouse of the cell." }],
      text: "Mitochondria are the powerhouse of the cell.",
    },
  ],
  raw_ref: "raw/api/claude:reindex-b",
  schema_version: 1,
};

test("reindex reads canonical sessions and makes them searchable", async () => {
  // Write two canonical sessions directly (simulating what the ingest server does).
  writeSession(canonicalDir, sessionA);
  writeSession(canonicalDir, sessionB);

  const count = await runUnify({ canonicalDir, indexPath });
  expect(count).toBe(2);

  const db = openIndex(indexPath);
  try {
    // "photosynthesis" appears in both messages of session A (user asks, assistant answers).
    const photoHits = searchMessages(db, "photosynthesis");
    expect(photoHits.length).toBe(2);
    expect(photoHits.every(h => h.session_id === sessionA.id)).toBe(true);

    // "mitochondria" appears in both messages of session B.
    const mitoHits = searchMessages(db, "mitochondria");
    expect(mitoHits.length).toBe(2);
    expect(mitoHits.every(h => h.session_id === sessionB.id)).toBe(true);

    // Unique words from each session return hits in only one session.
    expect(searchMessages(db, "glucose").length).toBe(1);
    expect(searchMessages(db, "powerhouse").length).toBe(1);
    expect(searchMessages(db, "cellular powerhouse").some((h) => h.message_id === "rb-m2")).toBe(true);
  } finally {
    db.close();
  }
});

test("reindex also reads historical sessions with capture_method export or takeout", async () => {
  const root2 = mkdtempSync(join(tmpdir(), "reindex-hist-"));
  const canonicalDir2 = join(root2, "canonical", "sessions");
  const indexPath2 = join(root2, "index", "sessions.db");
  try {
    const historicalSession: Session = {
      id: makeSessionId("chatgpt", "hist-1"),
      source: "chatgpt",
      source_id: "hist-1",
      capture_method: "export",
      title: "Historical",
      created_at: "2023-01-01T00:00:00.000Z",
      updated_at: "2023-01-01T00:01:00.000Z",
      default_model: null,
      account: null,
      messages: [
        {
          id: "h-m1",
          role: "user",
          created_at: "2023-01-01T00:00:01.000Z",
          parent_id: null,
          model: null,
          blocks: [{ type: "text", text: "Abiogenesis question." }],
          text: "Abiogenesis question.",
        },
      ],
      raw_ref: "chatgpt-chats:hist-1",
      schema_version: 1,
    };
    writeSession(canonicalDir2, historicalSession);

    const count = await runUnify({ canonicalDir: canonicalDir2, indexPath: indexPath2 });
    expect(count).toBe(1);

    const db = openIndex(indexPath2);
    try {
      expect(searchMessages(db, "abiogenesis").length).toBe(1);
    } finally {
      db.close();
    }
  } finally {
    rmSync(root2, { recursive: true, force: true });
  }
});
