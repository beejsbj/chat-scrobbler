import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGeminiAdapter, type GeminiPageContext } from "../packages/extension/src/providers/gemini";
import { assetReferences } from "../packages/extension/src/providers/assets";
import { buildRawCapture, type RawCapture } from "../packages/shared/src";
import { listBackfillPage } from "../src/core/asset-backfill";
import { storeRawCapture } from "../src/store/raw";
import { writeSession } from "../src/store/sessions";
import type { Session } from "../src/schema/types";

const signed = "https://lh3.googleusercontent.com/gg/file-1?sig=SECRET-SIGNATURE";
const candidate = (extra: Record<string, unknown> = {}) => ({ source: "gemini" as const, sourceId: "c", pointer: "file-1", url: signed, messageId: "m", filename: null, contentType: "image/png", ...extra });
const wiz = { at: "csrf", bl: "build", fSid: "sid" };
const page = (): GeminiPageContext => ({ readWizData: () => wiz, listConversationIds: () => ["c"], readConversationDom: () => null, readConversationAssets: () => [] });
const payload = [[[["c_c", "r_user"], null, [["prompt"], 1, [{ type: "image", file_id: "file-1", download_url: signed, mime_type: "image/png" }]], null]]];
const rpc = () => new Response(JSON.stringify([["wrb.fr", "hNvQHb", JSON.stringify(payload)]]));

test("retainUrls archives only https download urls the asset policy would fetch, and only when asked", () => {
  expect(assetReferences([candidate()])).toEqual([{ pointer: "file-1", message_id: "m", filename: null, content_type: "image/png" }]);
  expect(assetReferences([candidate()], { retainUrls: true })).toMatchObject([{ pointer: "file-1", download_url: signed }]);
  for (const url of ["blob:https://gemini.google.com/x", "data:image/png;base64,AAAA", "http://lh3.googleusercontent.com/x", "https://example.com/x", signed.replace("file-1", "f".repeat(3000)), null, "file-1"]) {
    expect(assetReferences([candidate({ url })], { retainUrls: true })[0]).not.toHaveProperty("download_url");
  }
});

test("Gemini capture archives the descriptor's download url beside its file id pointer", async () => {
  const captures: RawCapture[] = [];
  const original = (globalThis as any).chrome;
  (globalThis as any).chrome = { runtime: { sendMessage: (_m: unknown, reply: (r: unknown) => void) => reply({ ok: false }) } };
  const logs = console.error; console.error = () => {};
  try {
    await createGeminiAdapter(async () => rpc(), page()).captureOne!("c", null, {
      uploadAsset: async asset => ({ pointer: asset.pointer, local_path: "assets/x", sha256: "a".repeat(64) }),
      emitCapture: async capture => { captures.push(capture); },
    });
  } finally { console.error = logs; (globalThis as any).chrome = original; }
  expect(captures[0]!.asset_references).toEqual([{ pointer: "file-1", message_id: "r_user", filename: null, content_type: "image/png", download_url: signed }]);
});

const backfill = (reference: Record<string, unknown>, fetched: string[], logs: string[] = []) => {
  const original = (globalThis as any).chrome;
  const log = console.error; console.error = (line: string) => { logs.push(line); };
  (globalThis as any).chrome = { runtime: { sendMessage: (message: any, reply: (r: unknown) => void) => {
    fetched.push(message.url);
    reply({ ok: true, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], contentType: "image/png" });
  } } };
  return createGeminiAdapter(async () => { throw new Error("no direct fetch"); }, page()).backfillAssets!("c",
    [{ pointer: "file-1", message_id: "r_user", filename: null, content_type: "image/png", ...reference }], {
      beforeFetch: async () => {},
      uploadAsset: async asset => ({ pointer: asset.pointer, local_path: "assets/x", sha256: "b".repeat(64) }),
    }).finally(() => { console.error = log; (globalThis as any).chrome = original; });
};

test("backfill refetches an id pointer from its archived download url", async () => {
  const fetched: string[] = [];
  expect(await backfill({ download_url: signed }, fetched)).toMatchObject([{ pointer: "file-1", sha256: "b".repeat(64) }]);
  expect(fetched).toEqual([signed]);
});

test("backfill ignores a stored url that is not https, and a reference without one stays unavailable", async () => {
  for (const reference of [{ download_url: "blob:https://gemini.google.com/x" }, { download_url: "data:image/png;base64,AAAA" }, { download_url: "http://lh3.googleusercontent.com/x" }, {}]) {
    const fetched: string[] = [];
    expect(await backfill(reference, fetched)).toEqual([]);
    expect(fetched).toEqual([]);
  }
});

test("a failed fetch from a stored url never logs the url", async () => {
  const logs: string[] = [];
  const original = (globalThis as any).chrome;
  const log = console.error; console.error = (line: string) => { logs.push(line); };
  (globalThis as any).chrome = { runtime: { sendMessage: (_m: unknown, reply: (r: unknown) => void) => reply({ ok: false }) } };
  try {
    await createGeminiAdapter(async () => { throw new Error("no direct fetch"); }, page()).backfillAssets!("c",
      [{ pointer: "file-1", message_id: "r_user", filename: null, content_type: null, download_url: signed }], { beforeFetch: async () => {}, uploadAsset: async () => { throw new Error("unused"); } });
  } finally { console.error = log; (globalThis as any).chrome = original; }
  expect(logs.length).toBeGreaterThan(0);
  expect(logs.join("\n")).not.toContain("SECRET-SIGNATURE");
});

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function receiver(references: unknown) {
  const root = mkdtempSync(join(tmpdir(), "gemini-download-url-"));
  roots.push(root);
  const canonicalDir = join(root, "canonical"), rawDir = join(root, "raw");
  mkdirSync(canonicalDir, { recursive: true });
  const session: Session = {
    id: "gemini:c", source: "gemini", source_id: "c", capture_method: "api", title: "t", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z", default_model: null, account: null,
    messages: [{ id: "r_user", role: "user", created_at: null, parent_id: null, model: null, text: "", blocks: [{ type: "image", pointer: "file-1", filename: null, local_path: null, sha256: null, mime_type: "image/png" } as any] }],
    active_leaf_id: "r_user", raw_ref: "raw/api/x", schema_version: 2,
  };
  writeSession(canonicalDir, session);
  const capture = { ...buildRawCapture({ source: "gemini", sourceId: "c", endpoint: "/e", payload: [] }), asset_references: references } as RawCapture;
  storeRawCapture(rawDir, capture);
  return { canonicalDir, rawDir };
}
const refs = (page: ReturnType<typeof listBackfillPage>) => page.sessions[0]!.references;

test("the receiver's backfill page carries the archived download url, and old references still work", () => {
  const archived = [{ pointer: "file-1", message_id: "r_user", filename: null, content_type: "image/png", download_url: signed }];
  const { canonicalDir, rawDir } = receiver(archived);
  expect(refs(listBackfillPage(canonicalDir, "gemini", null, 25, rawDir))).toMatchObject([{ pointer: "file-1", download_url: signed }]);
  expect(refs(listBackfillPage(canonicalDir, "gemini", null, 25))[0]).not.toHaveProperty("download_url");
  const old = receiver([{ pointer: "file-1", message_id: "r_user", filename: null, content_type: "image/png" }]);
  expect(refs(listBackfillPage(old.canonicalDir, "gemini", null, 25, old.rawDir))[0]).not.toHaveProperty("download_url");
});

test("the receiver offers only a bounded https download url for the matching message and pointer", () => {
  const base = { pointer: "file-1", message_id: "r_user", filename: null, content_type: null };
  for (const bad of [{ ...base, download_url: "blob:https://gemini.google.com/x" }, { ...base, download_url: "data:image/png;base64,AAAA" },
    { ...base, download_url: 7 }, { ...base, download_url: "https://lh3.googleusercontent.com/" + "a".repeat(3000) }, { ...base, message_id: "other", download_url: signed }, null, "x"]) {
    const { canonicalDir, rawDir } = receiver([bad]);
    expect(refs(listBackfillPage(canonicalDir, "gemini", null, 25, rawDir))[0]).not.toHaveProperty("download_url");
  }
  const { canonicalDir, rawDir } = receiver("not-an-array");
  expect(refs(listBackfillPage(canonicalDir, "gemini", null, 25, rawDir))).toHaveLength(1);
});
