import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleIngestRequest } from "../packages/ingest/src";
import { buildRawCapture } from "../packages/shared/src";
import { openIndex, searchMessages } from "../src/indexer/sqlite";
import { parseChatgpt } from "../src/parsers/chatgpt";
import { listRawCaptures, readRawCapture, rawDirForCanonicalDir } from "../src/store/raw";
import { latestRawReference } from "../src/store/raw-catalog";
import { resolveLocalAssetPath, storeCanonicalAsset } from "../src/store/assets";
import { readSession, writeSession } from "../src/store/sessions";
import { markSessionDeleted } from "../src/store/tombstones";
import type { Block, Session } from "../src/schema/types";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function setup(ingestToken?: string) {
  const root = mkdtempSync(join(tmpdir(), "asset-backfill-"));
  roots.push(root);
  const canonicalDir = join(root, "canonical", "sessions");
  const indexPath = join(root, "index", "sessions.db");
  return { root, canonicalDir, indexPath, rawDir: rawDirForCanonicalDir(canonicalDir), opts: { canonicalDir, indexPath, ingestToken } };
}
type Ctx = ReturnType<typeof setup>;

const auth = (token?: string): Record<string, string> => token ? { authorization: `Bearer ${token}` } : {};
const get = (c: Ctx, query: string, token?: string) =>
  handleIngestRequest(new Request(`http://local/assets/backfill?${query}`, { headers: auth(token) }), c.opts);
const post = (c: Ctx, body: unknown, token?: string) =>
  handleIngestRequest(new Request("http://local/assets/backfill", { method: "POST", headers: auth(token), body: typeof body === "string" ? body : JSON.stringify(body) }), c.opts);

const media = (pointer: string, extra: Record<string, unknown> = {}): Block =>
  ({ type: "image", pointer, filename: null, local_path: null, sha256: null, mime_type: null, ...extra }) as Block;

function legacySession(sourceId: string, blocks: Block[], extra: Partial<Session> = {}): Session {
  return {
    id: `chatgpt:${sourceId}`, source: "chatgpt", source_id: sourceId, capture_method: "api", title: "Legacy title",
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z", default_model: null, account: null,
    messages: [
      { id: "m0", role: "user", created_at: null, parent_id: null, model: null, blocks: [{ type: "text", text: "zebra question" }], text: "zebra question" },
      { id: "m1", role: "assistant", created_at: null, parent_id: "m0", model: null, blocks, text: "see attached" },
    ],
    active_leaf_id: "m1", raw_ref: "raw/api/legacy", schema_version: 2, ...extra,
  };
}

function blob(c: Ctx, sourceId: string, bytes: string, pointer = "p") {
  return storeCanonicalAsset({ canonicalDir: c.canonicalDir, source: "chatgpt", sourceId, pointer, filename: "pic.png", contentType: "image/png", bytes: new TextEncoder().encode(bytes) });
}

async function ingestChatgpt(c: Ctx, sourceId: string) {
  const mapping = {
    root: { id: "root", message: null, parent: null, children: ["u1"] },
    u1: { id: "u1", parent: "root", children: ["a1"], message: { id: "u1", author: { role: "user" }, create_time: 1, recipient: "all", metadata: {},
      content: { content_type: "text", parts: ["hello branch"] } } },
    a1: { id: "a1", parent: "u1", children: [], message: { id: "a1", author: { role: "assistant" }, create_time: 2, recipient: "all", metadata: {},
      content: { content_type: "multimodal_text", parts: [{ content_type: "image_asset_pointer", asset_pointer: "file-service://file-EXP" }] } } },
  };
  const capture = buildRawCapture({ source: "chatgpt", sourceId, endpoint: "/backend-api/conversation/x",
    payload: { conversation_id: sourceId, title: "Real title", current_node: "a1", mapping },
    fetchedAt: "2026-01-01T00:00:00.000Z", conversationUpdatedAt: "2026-01-01T00:00:00Z" });
  const res = await handleIngestRequest(new Request("http://local/captures", { method: "POST", body: JSON.stringify(capture) }), c.opts);
  expect(res.status).toBe(200);
  return capture;
}

test("backfill endpoints require auth when a token is configured", async () => {
  const c = setup("secret");
  expect((await get(c, "source=chatgpt")).status).toBe(401);
  expect((await post(c, {})).status).toBe(401);
  expect((await get(c, "source=chatgpt", "secret")).status).toBe(200);
}, 30_000);

test("GET pages keyset-by-source_id, counts fully linked files as scanned, skips tombstones", async () => {
  const c = setup();
  const linked = blob(c, "b", "linked-bytes");
  writeSession(c.canonicalDir, legacySession("a", [media("ptr-a", { filename: "a.png", mime_type: "image/png" }), media("ptr-a"), { type: "attachment", kind: "file", pointer: "ptr-att", filename: null, local_path: null } as Block]));
  writeSession(c.canonicalDir, legacySession("b", [media("ptr-b", { local_path: linked.local_path, sha256: linked.sha256 })]));
  writeSession(c.canonicalDir, legacySession("c", [media("ptr-c", { local_path: "assets/chatgpt/c/gone.png" })]));
  writeSession(c.canonicalDir, legacySession("d", [media("ptr-d")]));
  writeSession(c.canonicalDir, legacySession("gone", [media("ptr-gone")]));
  markSessionDeleted(c.canonicalDir, { source: "chatgpt", source_id: "gone", deleted_at: "2026-01-01T00:00:00Z" });

  const first = await (await get(c, "source=chatgpt&limit=2")).json() as any;
  expect(first.ok).toBe(true);
  expect(first.sessions).toEqual([{ source_id: "a", references: [
    { pointer: "ptr-a", message_id: "m1", filename: "a.png", content_type: "image/png" },
    { pointer: "ptr-att", message_id: "m1", filename: null, content_type: null }] }]);
  expect(first.next_after).toBe("b");

  const second = await (await get(c, `source=chatgpt&limit=2&after=${first.next_after}`)).json() as any;
  expect(second.sessions.map((s: any) => s.source_id)).toEqual(["c", "d"]);
  expect(second.sessions[0].references[0].pointer).toBe("ptr-c");
  expect(second.next_after).toBeNull();
  expect(JSON.stringify([first, second])).not.toContain("gone");
}, 30_000);

test("GET validates source and limit; claude listing is empty without files", async () => {
  const c = setup();
  for (const q of ["source=bogus", "source=chatgpt&limit=0", "source=chatgpt&limit=101", "source=chatgpt&limit=2.5", "source=chatgpt&limit=abc", "source=chatgpt&after=a%2Fb"]) {
    expect((await get(c, q)).status).toBe(400);
  }
  expect(await (await get(c, "source=claude&limit=100")).json()).toEqual({ ok: true, sessions: [], next_after: null });
}, 30_000);

test("POST links legacy canonical without raw: derives local path, keeps content", async () => {
  const c = setup();
  const stored = blob(c, "other", "legacy-bytes");
  const session = legacySession("leg", [media("ptr-1", { filename: "keep.png" }), media("ptr-2"), media("ptr-ok", { local_path: "assets/chatgpt/leg/ok.png", sha256: "f".repeat(64) })]);
  writeSession(c.canonicalDir, session);
  const res = await post(c, { source: "chatgpt", source_id: "leg", assets: [
    { pointer: "ptr-1", message_id: "m1", filename: "keep.png", content_type: "image/png", sha256: stored.sha256, local_path: "../../../etc/passwd" },
    { pointer: "ptr-unmatched", message_id: "m1", sha256: stored.sha256, local_path: "x" },
    { pointer: "ptr-2", message_id: "wrong-message", sha256: stored.sha256, local_path: "x" }] });
  expect(await res.json()).toEqual({ ok: true, linked: 1, raw_ref: null });
  const after = readSession(c.canonicalDir, "chatgpt", "leg");
  const blocks = after.messages[1].blocks as any[];
  expect(blocks[0].local_path).toBe(`assets/chatgpt/leg/${stored.sha256}.png`);
  expect(blocks[0].sha256).toBe(stored.sha256);
  expect(blocks[0].filename).toBe("keep.png");
  expect(existsSync(resolveLocalAssetPath(c.canonicalDir, blocks[0].local_path))).toBe(true);
  expect(blocks[1].local_path).toBeNull();
  expect(blocks[2]).toMatchObject({ local_path: "assets/chatgpt/leg/ok.png", sha256: "f".repeat(64) });
  expect(after.title).toBe("Legacy title");
  expect(after.raw_ref).toBe("raw/api/legacy");
  expect(after.messages[0]).toEqual(session.messages[0]);
  expect(after.messages[1].text).toContain(blocks[0].local_path);
  expect(existsSync(c.rawDir) ? listRawCaptures(c.rawDir, "chatgpt", "leg") : []).toEqual([]);
  const db = openIndex(c.indexPath);
  expect(searchMessages(db, "zebra").length).toBe(1);
  db.close();
}, 30_000);

test("POST appends an immutable merged raw capture that reparses with the SHA", async () => {
  const c = setup();
  const original = await ingestChatgpt(c, "conv-r");
  const firstRef = latestRawReference(c.rawDir, "chatgpt", "conv-r")!;
  const before = readSession(c.canonicalDir, "chatgpt", "conv-r");
  expect((before.messages.find(m => m.id === "a1")!.blocks as any[])[0].local_path).toBeNull();

  const listed = await (await get(c, "source=chatgpt")).json() as any;
  expect(listed.sessions).toEqual([{ source_id: "conv-r", references: [{ pointer: "file-service://file-EXP", message_id: "a1", filename: null, content_type: null }] }]);

  const stored = blob(c, "conv-r", "raw-bytes");
  const res = await post(c, { source: "chatgpt", source_id: "conv-r", assets: [
    { pointer: "file-service://file-EXP", message_id: "a1", filename: "gen.png", content_type: "image/png", sha256: stored.sha256, local_path: "bogus" }] });
  const body = await res.json() as any;
  expect(body).toMatchObject({ ok: true, linked: 1 });
  expect(body.raw_ref).not.toBe(firstRef);
  expect(listRawCaptures(c.rawDir, "chatgpt", "conv-r")).toContain(firstRef);
  expect(readRawCapture(c.rawDir, firstRef).assets).toEqual([]);

  const merged = readRawCapture(c.rawDir, body.raw_ref);
  expect(merged.payload).toEqual(original.payload);
  expect(merged.endpoint).toBe(original.endpoint);
  expect(merged.conversation_updated_at).toBe(original.conversation_updated_at);
  expect(merged.fetched_at).toBe(original.fetched_at);
  expect(merged.asset_backfilled_at).toBeDefined();
  expect(merged.assets).toEqual([expect.objectContaining({ pointer: "file-service://file-EXP", message_id: "a1", filename: "gen.png",
    content_type: "image/png", sha256: stored.sha256, local_path: `assets/chatgpt/conv-r/${stored.sha256}.png` })]);

  const after = readSession(c.canonicalDir, "chatgpt", "conv-r");
  expect(after.raw_ref).toBe(body.raw_ref);
  expect(after.title).toBe("Real title");
  expect(after.messages.map(m => m.id)).toEqual(before.messages.map(m => m.id));
  expect(after.messages.find(m => m.id === "u1")!.text).toBe("hello branch");

  const [reparsed] = parseChatgpt(merged, { raw_ref: body.raw_ref });
  expect(reparsed.messages).toEqual(after.messages);
  expect((reparsed.messages.find(m => m.id === "a1")!.blocks as any[])[0].sha256).toBe(stored.sha256);

  // Posting the same link again is idempotent: no new raw version.
  const again = await (await post(c, { source: "chatgpt", source_id: "conv-r", assets: [{ pointer: "file-service://file-EXP", message_id: "a1", sha256: stored.sha256, filename: "gen.png", content_type: "image/png" }] })).json() as any;
  expect(again.raw_ref).toBe(body.raw_ref);
  expect((await (await get(c, "source=chatgpt")).json() as any).sessions).toEqual([]);
}, 30_000);

test("POST rejects bad input and unknown targets categorically", async () => {
  const c = setup();
  const stored = blob(c, "x", "bytes");
  writeSession(c.canonicalDir, legacySession("exists", [media("p")]));
  const ref = { pointer: "p", message_id: "m1", sha256: stored.sha256 };
  const cases: Array<[unknown, number]> = [
    ["{not json", 400],
    [{ source: "bogus", source_id: "exists", assets: [ref] }, 400],
    [{ source: "chatgpt", source_id: "../x", assets: [ref] }, 400],
    [{ source: "chatgpt", source_id: "exists", assets: "no" }, 400],
    [{ source: "chatgpt", source_id: "exists", assets: [{ ...ref, sha256: "ABC" }] }, 400],
    [{ source: "chatgpt", source_id: "exists", assets: [{ ...ref, sha256: stored.sha256.toUpperCase() }] }, 400],
    [{ source: "chatgpt", source_id: "exists", assets: [{ ref: 1 }] }, 400],
    [{ source: "chatgpt", source_id: "exists", assets: Array.from({ length: 1001 }, () => ref) }, 400],
    [{ source: "chatgpt", source_id: "exists", assets: [{ ...ref, sha256: "0".repeat(64) }] }, 404],
    [{ source: "chatgpt", source_id: "nope", assets: [ref] }, 404],
  ];
  for (const [body, status] of cases) {
    const res = await post(c, body);
    expect(res.status).toBe(status);
    expect(JSON.stringify(await res.json())).not.toContain(stored.sha256.slice(0, 8));
  }
  expect((readSession(c.canonicalDir, "chatgpt", "exists").messages[1].blocks as any[])[0].local_path).toBeNull();

  writeSession(c.canonicalDir, legacySession("dead", [media("p")]));
  markSessionDeleted(c.canonicalDir, { source: "chatgpt", source_id: "dead", deleted_at: "2026-01-01T00:00:00Z" });
  expect((await post(c, { source: "chatgpt", source_id: "dead", assets: [ref] })).status).toBe(410);

  const big = await post(c, JSON.stringify({ source: "chatgpt", source_id: "exists", assets: [], pad: "x".repeat(1024 * 1024 + 1) }));
  expect(big.status).toBe(413);
}, 30_000);
