// test/ingest-spine.test.ts
// Fat ingest: POST /captures parses via the *_api parsers, writes canonical, and
// indexes immediately. POST /status answers per-conversation spine state.
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleIngestRequest } from "../packages/ingest/src";
import { foldCaptureIntoSpine } from "../packages/ingest/src/pipeline";
import { openIndex, searchMessages, indexSession, type EmbeddingProvider } from "../src/indexer/sqlite";
import { readSession, writeSession } from "../src/store/sessions";
import { makeSessionId, type Session } from "../src/schema/types";
import type { RawCapture } from "../packages/shared/src";
import chatgptApi from "./fixtures/chatgpt-api-sample.json";
import claudeApi from "./fixtures/claude-api-sample.json";

function ctx() {
  const root = mkdtempSync(join(tmpdir(), "ingest-spine-"));
  return {
    root,
    canonicalDir: join(root, "canonical", "sessions"),
    indexPath: join(root, "index", "sessions.db"),
  };
}

test("POST /captures folds the capture into canonical + index immediately", async () => {
  const { root, canonicalDir, indexPath } = ctx();
  try {
    const res = await handleIngestRequest(
      new Request("http://local/captures", { method: "POST", body: JSON.stringify(chatgptApi) }),
      { canonicalDir, indexPath },
    );
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    // spine result reports the indexed session
    expect(body.spine[0]).toMatchObject({ session_id: "chatgpt:conv-1", indexed: true });
    // canonical written with capture_method api
    const canon = JSON.parse(readFileSync(join(canonicalDir, "chatgpt", "conv-1.json"), "utf8"));
    expect(canon.capture_method).toBe("api");
    // searchable right away (no separate unify run)
    const db = openIndex(indexPath);
    expect(searchMessages(db, "protective").length).toBe(1);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /captures keeps canonical and literal index reliable when embeddings fail", async () => {
  const { root, canonicalDir, indexPath } = ctx();
  const provider: EmbeddingProvider = {
    kind: "test-failing-document",
    async embed(): Promise<number[]> {
      throw new Error("document embedding service unavailable");
    },
  };
  try {
    const res = await handleIngestRequest(
      new Request("http://local/captures", { method: "POST", body: JSON.stringify(chatgptApi) }),
      { canonicalDir, indexPath, embeddingProvider: provider },
    );
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, count: 1 });
    expect(body.spine[0]).toMatchObject({ session_id: "chatgpt:conv-1", indexed: true });
    expect(existsSync(join(canonicalDir, "chatgpt", "conv-1.json"))).toBe(true);

    const db = openIndex(indexPath);
    try {
      expect(searchMessages(db, "protective", { embeddingProvider: null })).toHaveLength(1);
      const embeddingRows = db.query(
        "SELECT COUNT(*) AS count FROM message_embeddings WHERE session_id = ?",
      ).get("chatgpt:conv-1") as { count: number };
      expect(embeddingRows.count).toBe(0);
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /status reports synced / stale / missing from the index", async () => {
  const { root, canonicalDir, indexPath } = ctx();
  try {
    // first ingest conv-1 (indexed updated_at = 2023-11-14T22:23:20Z from update_time 1700000600)
    await handleIngestRequest(
      new Request("http://local/captures", { method: "POST", body: JSON.stringify(chatgptApi) }),
      { canonicalDir, indexPath },
    );

    const res = await handleIngestRequest(
      new Request("http://local/status", {
        method: "POST",
        body: JSON.stringify({
          source: "chatgpt",
          conversations: [
            { id: "conv-1", updated_at: "2023-11-14T22:23:20.000Z" }, // equal -> synced
            { id: "conv-1-newer", updated_at: "2099-01-01T00:00:00.000Z" }, // not indexed -> missing
            { id: "conv-1", updated_at: "2099-01-01T00:00:00.000Z" }, // indexed but older -> stale
          ],
        }),
      }),
      { canonicalDir, indexPath },
    );
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.statuses["conv-1"]).toBe("stale"); // last write wins for duplicate id (newer query)
    expect(body.statuses["conv-1-newer"]).toBe("missing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /status: a synced conversation reports synced", async () => {
  const { root, canonicalDir, indexPath } = ctx();
  try {
    await handleIngestRequest(
      new Request("http://local/captures", { method: "POST", body: JSON.stringify(chatgptApi) }),
      { canonicalDir, indexPath },
    );
    const res = await handleIngestRequest(
      new Request("http://local/status", {
        method: "POST",
        body: JSON.stringify({ source: "chatgpt", conversations: [{ id: "conv-1", updated_at: "2023-11-14T22:23:20.000Z" }] }),
      }),
      { canonicalDir, indexPath },
    );
    const body = await res.json() as any;
    expect(body.statuses["conv-1"]).toBe("synced");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /status marks epoch-seconds string newer than indexed conversation as stale", async () => {
  const { root, canonicalDir, indexPath } = ctx();
  try {
    await handleIngestRequest(
      new Request("http://local/captures", { method: "POST", body: JSON.stringify(chatgptApi) }),
      { canonicalDir, indexPath },
    );
    const res = await handleIngestRequest(
      new Request("http://local/status", {
        method: "POST",
        body: JSON.stringify({
          source: "chatgpt",
          conversations: [{ id: "conv-1", updated_at: "1717689600" }],
        }),
      }),
      { canonicalDir, indexPath },
    );
    const body = await res.json() as any;
    expect(body.statuses["conv-1"]).toBe("stale");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("foldCaptureIntoSpine replaces an export session with a continued api capture", () => {
  const root = mkdtempSync(join(tmpdir(), "fold-spine-"));
  const canonicalDir = join(root, "canonical", "sessions");
  const indexPath = join(root, "index", "sessions.db");
  mkdirSync(join(root, "index"), { recursive: true });
  const db = openIndex(indexPath);
  try {
    const exportSession: Session = {
      id: makeSessionId("claude", "cl-1"),
      source: "claude",
      source_id: "cl-1",
      capture_method: "export",
      title: "Healing",
      created_at: "2025-01-01T00:00:00.000Z",
      updated_at: "2025-01-01T00:01:00.000Z",
      default_model: null,
      account: "org-1",
      messages: [
        {
          id: "m1",
          role: "user",
          created_at: "2025-01-01T00:00:01.000Z",
          parent_id: null,
          model: null,
          blocks: [{ type: "text", text: "What is healing?" }],
          text: "What is healing?",
        },
      ],
      raw_ref: "claude-chats:cl-1",
      schema_version: 1,
    };
    writeSession(canonicalDir, exportSession);
    indexSession(db, exportSession);

    const result = foldCaptureIntoSpine(claudeApi as RawCapture, { canonicalDir, db });
    const session = readSession(canonicalDir, "claude", "cl-1");
    const row = db.query(
      "SELECT message_count, updated_at FROM sessions WHERE id = ?",
    ).get(makeSessionId("claude", "cl-1")) as { message_count: number; updated_at: string } | null;

    expect(result).toEqual([
      { session_id: "claude:cl-1", source: "claude", source_id: "cl-1", indexed: true },
    ]);
    expect(session.capture_method).toBe("api");
    expect(session.messages).toHaveLength(2);
    expect(session.updated_at).toBe("2025-01-01T00:10:00.000Z");
    expect(row).toEqual({ message_count: 2, updated_at: "2025-01-01T00:10:00.000Z" });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
