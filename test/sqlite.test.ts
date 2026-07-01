// test/sqlite.test.ts
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteIndexedSession, openIndex, indexSession, searchMessages, searchMessagesWithEmbeddings, listSessions, type EmbeddingProvider } from "../src/indexer/sqlite";
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

  const hits = searchMessages(db, "protective", { embeddingProvider: null });
  expect(hits).toHaveLength(1);
  expect(hits[0].session_id).toBe("chatgpt:a");
  expect(hits[0].message_id).toBe("a-m1");
  expect(hits[0].source).toBe("chatgpt");
  expect(hits[0].snippet.toLowerCase()).toContain("protective");
  expect(hits[0].provenance).toBe("literal");
  expect(hits[0].score).toBeGreaterThan(0);
  expect(hits[0].match_sources).toEqual(["literal"]);
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

test("search includes semantic-only hits in the same ranked result set", () => {
  const provider: EmbeddingProvider = {
    dimensions: 3,
    embed(text: string): number[] {
      if (text.includes("nostalgia") || text.includes("homesick")) return [1, 0, 0];
      return [0, 1, 0];
    },
  };
  const db = openIndex(":memory:");
  indexSession(db, mk("a", "chatgpt", "Exact", "nostalgia and old houses"), { embeddingProvider: provider });
  indexSession(db, mk("b", "claude", "Semantic", "homesick feeling after moving"), { embeddingProvider: provider });

  const hits = searchMessages(db, "nostalgia", { embeddingProvider: provider, limit: 10 });
  expect(hits.map((h) => h.session_id)).toContain("chatgpt:a");
  expect(hits.map((h) => h.session_id)).toContain("claude:b");
  expect(hits[0].session_id).toBe("chatgpt:a");
  const semantic = hits.find((h) => h.session_id === "claude:b");
  expect(semantic?.provenance).toBe("semantic");
  expect(semantic?.match_sources).toEqual(["semantic"]);
  expect(semantic?.snippet).toContain("homesick");
});

test("new embeddings record provider metadata and vector dimension", () => {
  const provider: EmbeddingProvider = {
    kind: "test-provider",
    model: "semantic-v1",
    dimensions: 2,
    embed(): number[] {
      return [1, 0];
    },
  };
  const db = openIndex(":memory:");
  indexSession(db, mk("a", "chatgpt", "T", "provider metadata"), { embeddingProvider: provider });

  const row = db.query(
    `SELECT provider_kind, provider_model, dimension FROM message_embeddings WHERE session_id = ?`,
  ).get("chatgpt:a") as { provider_kind: string; provider_model: string; dimension: number };

  expect(row).toEqual({
    provider_kind: "test-provider",
    provider_model: "semantic-v1",
    dimension: 2,
  });
});

test("semantic search ignores stale provider or model embeddings while literal search still works", () => {
  const oldProvider: EmbeddingProvider = {
    kind: "test-provider",
    model: "old-space",
    dimensions: 2,
    embed(): number[] {
      return [1, 0];
    },
  };
  const currentProvider: EmbeddingProvider = {
    kind: "test-provider",
    model: "current-space",
    dimensions: 2,
    embed(): number[] {
      return [1, 0];
    },
  };
  const db = openIndex(":memory:");
  indexSession(db, mk("a", "chatgpt", "Old", "legacy embedding text"), { embeddingProvider: oldProvider });

  expect(searchMessages(db, "not-present", { embeddingProvider: currentProvider })).toEqual([]);

  const literal = searchMessages(db, "legacy", { embeddingProvider: currentProvider });
  expect(literal).toHaveLength(1);
  expect(literal[0].session_id).toBe("chatgpt:a");
  expect(literal[0].provenance).toBe("literal");
  expect(literal[0].match_sources).toEqual(["literal"]);
});

test("semantic search ignores corrupt rows whose stored vector length mismatches the query", () => {
  const provider: EmbeddingProvider = {
    kind: "test-provider",
    model: "semantic-v1",
    dimensions: 3,
    embed(): number[] {
      return [1, 0, 0];
    },
  };
  const db = openIndex(":memory:");
  indexSession(db, mk("a", "chatgpt", "T", "short vector stale text"), { embeddingProvider: provider });
  db.run(
    `UPDATE message_embeddings SET embedding = ?, dimension = ? WHERE session_id = ?`,
    [JSON.stringify([1, 0]), 3, "chatgpt:a"],
  );

  expect(searchMessages(db, "not-present", { embeddingProvider: provider })).toEqual([]);
  expect(searchMessages(db, "short", { embeddingProvider: provider })).toHaveLength(1);
});

test("existing embedding tables migrate without making old semantic rows eligible", () => {
  const root = mkdtempSync(join(tmpdir(), "semantic-migrate-"));
  try {
    const indexPath = join(root, "sessions.db");
    const oldDb = new Database(indexPath);
    oldDb.run(
      `CREATE TABLE message_embeddings (
        session_id TEXT NOT NULL, message_id TEXT NOT NULL, embedding TEXT NOT NULL,
        text TEXT NOT NULL, role TEXT, created_at TEXT, source TEXT, title TEXT,
        PRIMARY KEY (session_id, message_id));`,
    );
    oldDb.run(
      `INSERT INTO message_embeddings (session_id, message_id, embedding, text, role, created_at, source, title)
       VALUES (?,?,?,?,?,?,?,?)`,
      ["chatgpt:old", "old-m1", JSON.stringify([1, 0]), "old semantic row", "user", null, "chatgpt", "Old"],
    );
    oldDb.close();

    const reopened = openIndex(indexPath);
    try {
      indexSession(reopened, mk("a", "chatgpt", "T", "literal text"));
      const currentProvider: EmbeddingProvider = {
        kind: "test-provider",
        model: "current-space",
        dimensions: 2,
        embed(): number[] {
          return [1, 0];
        },
      };

      expect(searchMessages(reopened, "not-present", { embeddingProvider: currentProvider })).toEqual([]);
      expect(searchMessages(reopened, "literal", { embeddingProvider: currentProvider })).toHaveLength(1);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("search dedupes literal and semantic matches while preserving both sources", () => {
  const provider: EmbeddingProvider = {
    dimensions: 2,
    embed(text: string): number[] {
      return text.includes("protection") ? [1, 0] : [0, 1];
    },
  };
  const db = openIndex(":memory:");
  indexSession(db, mk("a", "chatgpt", "T", "protection matters"), { embeddingProvider: provider });

  const hits = searchMessages(db, "protection", { embeddingProvider: provider });
  expect(hits).toHaveLength(1);
  expect(hits[0].provenance).toBe("hybrid");
  expect(hits[0].match_sources).toEqual(["literal", "semantic"]);
});

test("async search falls back to literal hits when query embedding fails", async () => {
  const provider: EmbeddingProvider = {
    kind: "test-failing-query",
    async embed(): Promise<number[]> {
      throw new Error("query embedding service unavailable");
    },
  };
  const db = openIndex(":memory:");
  indexSession(db, mk("a", "chatgpt", "T", "protection matters"), { embeddingProvider: null });

  const hits = await searchMessagesWithEmbeddings(db, "protection", { embeddingProvider: provider });

  expect(hits).toHaveLength(1);
  expect(hits[0].session_id).toBe("chatgpt:a");
  expect(hits[0].provenance).toBe("literal");
  expect(hits[0].match_sources).toEqual(["literal"]);
});

test("deleteIndexedSession removes session, FTS, and embedding rows for a capture", () => {
  const provider: EmbeddingProvider = {
    dimensions: 2,
    embed(): number[] {
      return [1, 0];
    },
  };
  const db = openIndex(":memory:");
  indexSession(db, mk("a", "chatgpt", "Delete me", "local-only secret"), { embeddingProvider: provider });
  indexSession(db, mk("b", "chatgpt", "Keep me", "local-only secret kept"), { embeddingProvider: provider });

  const result = deleteIndexedSession(db, "chatgpt", "a");

  expect(result).toMatchObject({ deleted: true, sessionIds: ["chatgpt:a"] });
  expect(listSessions(db).map((s) => s.id)).toEqual(["chatgpt:b"]);
  expect(searchMessages(db, "secret")).toHaveLength(1);
  const embeddingRows = db.query(
    "SELECT COUNT(*) AS count FROM message_embeddings WHERE session_id = ?",
  ).get("chatgpt:a") as { count: number };
  expect(embeddingRows.count).toBe(0);
});
