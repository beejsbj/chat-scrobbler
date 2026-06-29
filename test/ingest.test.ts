import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleIngestRequest } from "../packages/ingest/src";
import { buildRawCapture } from "../packages/shared/src";
import { resolveLocalAssetPath, storeCanonicalAsset } from "../src/store/assets";
import { indexSession, listSessions, openIndex } from "../src/indexer/sqlite";
import { writeSession } from "../src/store/sessions";
import type { Session } from "../src/schema/types";

interface IngestTestResponse {
  ok: boolean;
  count: number;
  spine?: unknown[];
  error?: string;
  service?: string;
}

test("health endpoint reports receiver status", async () => {
  const res = await handleIngestRequest(new Request("http://local/health"), {});
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, service: "chat-scrobbler-ingest" });
});

test("capture endpoint accepts a single raw capture and returns count", async () => {
  const capture = buildRawCapture({
    source: "chatgpt",
    sourceId: "conv-1",
    endpoint: "/backend-api/conversation/conv-1",
    payload: { mapping: { root: true } },
    fetchedAt: "2026-06-05T10:00:00.000Z",
  });

  const res = await handleIngestRequest(
    new Request("http://local/captures", { method: "POST", body: JSON.stringify(capture) }),
    {},
  );
  const body = await res.json() as IngestTestResponse;

  expect(res.status).toBe(200);
  expect(body).toMatchObject({ ok: true, count: 1 });
});

test("asset endpoint stores content-addressed files beside canonical sessions", async () => {
  const root = mkdtempSync(join(tmpdir(), "ingest-asset-"));
  const canonicalDir = join(root, "canonical", "sessions");
  const opts = { canonicalDir, indexPath: join(root, "index", "sessions.db"), ingestToken: "secret-token" };
  try {
    const makeReq = () => new Request("http://local/assets?source=chatgpt&source_id=conv-1&pointer=file-service%3A%2F%2Ffile-1&filename=pic.png", {
      method: "POST",
      headers: { authorization: "Bearer secret-token", "content-type": "image/png" },
      body: new Uint8Array([1, 2, 3]),
    });
    const res = await handleIngestRequest(makeReq(), opts);
    const body = await res.json() as { ok: boolean; local_path: string; size_bytes: number };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.local_path).toMatch(/^assets\/chatgpt\/conv-1\/[a-f0-9]+\.png$/);
    expect(body.size_bytes).toBe(3);
    expect(existsSync(resolveLocalAssetPath(canonicalDir, body.local_path))).toBe(true);

    const res2 = await handleIngestRequest(makeReq(), opts);
    const body2 = await res2.json() as { local_path: string };
    expect(body2.local_path).toBe(body.local_path);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DELETE /captures removes one local capture from canonical, assets, and index", async () => {
  const root = mkdtempSync(join(tmpdir(), "ingest-delete-"));
  const canonicalDir = join(root, "canonical", "sessions");
  const indexPath = join(root, "index", "sessions.db");
  const session: Session = {
    id: "chatgpt:conv-delete",
    source: "chatgpt",
    source_id: "conv-delete",
    capture_method: "api",
    title: "Delete me",
    created_at: "2026-06-05T10:00:00.000Z",
    updated_at: "2026-06-05T10:01:00.000Z",
    default_model: null,
    account: null,
    raw_ref: "chatgpt-api:conv-delete",
    schema_version: 1,
    messages: [{
      id: "m1",
      role: "user",
      created_at: null,
      parent_id: null,
      model: null,
      blocks: [{ type: "text", text: "local-only secret" }],
      text: "local-only secret",
    }],
  };
  try {
    const sessionPath = writeSession(canonicalDir, session);
    const asset = storeCanonicalAsset({
      canonicalDir,
      source: "chatgpt",
      sourceId: "conv-delete",
      pointer: "file-service://file-1",
      filename: "pic.png",
      contentType: "image/png",
      bytes: new Uint8Array([1, 2, 3]),
    });
    const assetPath = resolveLocalAssetPath(canonicalDir, asset.local_path);
    mkdirSync(join(root, "index"), { recursive: true });
    const db = openIndex(indexPath);
    indexSession(db, session);
    db.close();

    const res = await handleIngestRequest(
      new Request("http://local/captures?source=chatgpt&source_id=conv-delete", {
        method: "DELETE",
        headers: { authorization: "Bearer secret-token" },
      }),
      { canonicalDir, indexPath, ingestToken: "secret-token" },
    );
    const body = await res.json() as any;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      source: "chatgpt",
      source_id: "conv-delete",
      local_only: true,
      canonical: { sessionDeleted: true, assetsDeleted: true },
      index: { deleted: true },
    });
    expect(existsSync(sessionPath)).toBe(false);
    expect(existsSync(assetPath)).toBe(false);

    const checkDb = openIndex(indexPath);
    try {
      expect(listSessions(checkDb)).toEqual([]);
    } finally {
      checkDb.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DELETE /captures requires the configured bearer token", async () => {
  const root = mkdtempSync(join(tmpdir(), "ingest-delete-auth-"));
  try {
    const res = await handleIngestRequest(
      new Request("http://local/captures?source=chatgpt&source_id=conv-delete", { method: "DELETE" }),
      { canonicalDir: join(root, "canonical", "sessions"), indexPath: join(root, "index", "sessions.db"), ingestToken: "secret-token" },
    );
    const body = await res.json() as IngestTestResponse;

    expect(res.status).toBe(401);
    expect(body.ok).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("capture endpoint rejects malformed captures", async () => {
  const res = await handleIngestRequest(
    new Request("http://local/captures", { method: "POST", body: JSON.stringify({ source: "chatgpt" }) }),
    {},
  );
  const body = await res.json() as IngestTestResponse;

  expect(res.status).toBe(400);
  expect(body.error).toContain("method");
});

test("capture endpoint returns 401 when token configured and header is missing", async () => {
  const capture = buildRawCapture({
    source: "gemini",
    sourceId: "gem-1",
    endpoint: "/_/BardChatUi/data/batchexecute",
    payload: {},
    fetchedAt: "2026-06-05T10:00:00.000Z",
  });

  const res = await handleIngestRequest(
    new Request("http://local/captures", { method: "POST", body: JSON.stringify(capture) }),
    { ingestToken: "secret-token" },
  );
  const body = await res.json() as IngestTestResponse;

  expect(res.status).toBe(401);
  expect(body.ok).toBe(false);
});

test("capture endpoint returns 401 when token configured and header is wrong", async () => {
  const capture = buildRawCapture({
    source: "gemini",
    sourceId: "gem-1",
    endpoint: "/_/BardChatUi/data/batchexecute",
    payload: {},
    fetchedAt: "2026-06-05T10:00:00.000Z",
  });

  const res = await handleIngestRequest(
    new Request("http://local/captures", {
      method: "POST",
      body: JSON.stringify(capture),
      headers: { "authorization": "Bearer wrong-token" },
    }),
    { ingestToken: "secret-token" },
  );
  const body = await res.json() as IngestTestResponse;

  expect(res.status).toBe(401);
  expect(body.ok).toBe(false);
});

test("capture endpoint accepts correct bearer token", async () => {
  const capture = buildRawCapture({
    source: "gemini",
    sourceId: "gem-1",
    endpoint: "/_/BardChatUi/data/batchexecute",
    payload: {},
    fetchedAt: "2026-06-05T10:00:00.000Z",
  });

  const res = await handleIngestRequest(
    new Request("http://local/captures", {
      method: "POST",
      body: JSON.stringify(capture),
      headers: { "authorization": "Bearer secret-token" },
    }),
    { ingestToken: "secret-token" },
  );
  const body = await res.json() as IngestTestResponse;

  expect(res.status).toBe(200);
  expect(body.ok).toBe(true);
  expect(body.count).toBe(1);
});

test("capture endpoint allows any request when no token configured (local dev)", async () => {
  const capture = buildRawCapture({
    source: "chatgpt",
    sourceId: "conv-noauth",
    endpoint: "/backend-api/conversation/conv-noauth",
    payload: {},
    fetchedAt: "2026-06-05T10:00:00.000Z",
  });

  // No ingestToken set -- should succeed without any Authorization header
  const res = await handleIngestRequest(
    new Request("http://local/captures", { method: "POST", body: JSON.stringify(capture) }),
    {},
  );
  const body = await res.json() as IngestTestResponse;

  expect(res.status).toBe(200);
  expect(body.ok).toBe(true);
});

test("capture endpoint accepts batches and returns correct count", async () => {
  const captures = [
    buildRawCapture({
      source: "chatgpt",
      sourceId: "conv-1",
      endpoint: "/backend-api/conversation/conv-1",
      payload: {},
      fetchedAt: "2026-06-05T10:00:00.000Z",
    }),
    buildRawCapture({
      source: "claude",
      sourceId: "cl-1",
      endpoint: "/api/organizations/org/chat_conversations/cl-1",
      payload: {},
      fetchedAt: "2026-06-05T10:01:00.000Z",
    }),
  ];

  const res = await handleIngestRequest(
    new Request("http://local/captures", { method: "POST", body: JSON.stringify(captures) }),
    {},
  );
  const body = await res.json() as IngestTestResponse;

  expect(body.count).toBe(2);
  expect(body.ok).toBe(true);
});

test("capture endpoint logs fat-mode parse failures with light capture context", async () => {
  const root = mkdtempSync(join(tmpdir(), "ingest-log-"));
  const errorSpy = spyOn(console, "error").mockImplementation(() => {});
  const capture = buildRawCapture({
    source: "chatgpt",
    sourceId: "conv-log",
    endpoint: "/backend-api/conversation/conv-log?token=secret-token",
    rawUrl: "https://chatgpt.com/backend-api/conversation/conv-log?token=secret-token",
    payload: [null, { secret: "do-not-log" }],
    fetchedAt: "2026-06-05T10:00:00.000Z",
  });

  try {
    const res = await handleIngestRequest(
      new Request("http://local/captures", { method: "POST", body: JSON.stringify(capture) }),
      { canonicalDir: join(root, "canonical", "sessions"), indexPath: join(root, "index", "sessions.db") },
    );
    const body = await res.json() as IngestTestResponse;

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    const [line] = errorSpy.mock.calls[0];
    expect(typeof line).toBe("string");
    const log = JSON.parse(line as string) as Record<string, unknown>;
    expect(log).toMatchObject({
      event: "capture_parse_failed",
      parser_key: "chatgpt:api",
      source_id: "conv-log",
      url: "https://chatgpt.com/backend-api/conversation/conv-log",
    });
    expect(typeof log.reason).toBe("string");
    expect(log.reason).not.toContain("do-not-log");
    expect(line as string).not.toContain("secret-token");
    expect(line as string).not.toContain("do-not-log");
  } finally {
    errorSpy.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
