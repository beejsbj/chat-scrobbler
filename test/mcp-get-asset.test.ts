import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/mcp/server";
import { handleGetAsset } from "../src/mcp/get-asset";
import { assetBlobPath, resolveLocalAssetPath, storeCanonicalAsset } from "../src/store/assets";
import { writeSession } from "../src/store/sessions";
import type { Block, Session } from "../src/schema/types";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mcp-asset-"));
  const canonicalDir = join(root, "canonical", "sessions");
  const store = (sourceId: string, bytes: Uint8Array, contentType: string | null, filename: string | null = null) =>
    storeCanonicalAsset({ canonicalDir, source: "chatgpt", sourceId, pointer: `file-service://${sourceId}`, messageId: "m1", filename, contentType, bytes });
  const session = (sourceId: string, blocks: Block[]): Session => {
    const s: Session = {
      id: `chatgpt:${sourceId}`, source: "chatgpt", source_id: sourceId, capture_method: "api",
      title: "Assets", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
      default_model: null, account: null, raw_ref: `chatgpt:${sourceId}`, schema_version: 2,
      messages: [{ id: "m1", role: "user", created_at: null, parent_id: null, model: null, blocks, text: "" }],
    } as Session;
    writeSession(canonicalDir, s);
    return s;
  };
  return { root, canonicalDir, store, session, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function imageBlock(stored: { local_path: string; sha256: string }, mime: string | null, filename: string | null = null): Block {
  return { type: "image", pointer: "file-service://x", filename, local_path: stored.local_path, sha256: stored.sha256, mime_type: mime };
}

test("get_asset returns a referenced image as MCP image content", () => {
  const f = fixture();
  try {
    const stored = f.store("s1", PNG, "image/png", "cat.png");
    f.session("s1", [imageBlock(stored, "image/png", "cat.png")]);
    const res = handleGetAsset(f.canonicalDir, { session_id: "chatgpt:s1", sha256: stored.sha256 });
    expect(res.isError).toBeFalsy();
    const image = res.content.find(c => c.type === "image");
    expect(image).toEqual({ type: "image", mimeType: "image/png", data: Buffer.from(PNG).toString("base64") });
    const meta = res.content.find(c => c.type === "text");
    expect(meta && "text" in meta ? JSON.parse(meta.text) : null).toMatchObject({ sha256: stored.sha256, mime_type: "image/png", size_bytes: PNG.byteLength, filename: "cat.png", message_id: "m1" });
  } finally { f.cleanup(); }
});

test("get_asset sniffs images stored as application/octet-stream", () => {
  const f = fixture();
  try {
    const stored = f.store("s1", PNG, "application/octet-stream");
    f.session("s1", [imageBlock(stored, null)]);
    const res = handleGetAsset(f.canonicalDir, { session_id: "chatgpt:s1", sha256: stored.sha256 });
    expect(res.content.find(c => c.type === "image")).toMatchObject({ mimeType: "image/png" });
  } finally { f.cleanup(); }
});

test("get_asset accepts an asset local_path in place of the bare hash", () => {
  const f = fixture();
  try {
    const stored = f.store("s1", PNG, "image/png");
    f.session("s1", [imageBlock(stored, "image/png")]);
    const res = handleGetAsset(f.canonicalDir, { session_id: "chatgpt:s1", sha256: stored.local_path });
    expect(res.isError).toBeFalsy();
    expect(res.content.some(c => c.type === "image")).toBe(true);
  } finally { f.cleanup(); }
});

test("get_asset refuses a stored blob that the named session does not reference", () => {
  const f = fixture();
  try {
    const other = f.store("other", PNG, "image/png");
    f.session("other", [imageBlock(other, "image/png")]);
    f.session("s1", [{ type: "text", text: "no images here" }]);
    const res = handleGetAsset(f.canonicalDir, { session_id: "chatgpt:s1", sha256: other.sha256 });
    expect(res.isError).toBe(true);
    expect(res.content.some(c => c.type === "image")).toBe(false);
  } finally { f.cleanup(); }
});

test("get_asset rejects malformed hashes and session ids", () => {
  const f = fixture();
  try {
    for (const args of [
      { session_id: "chatgpt:../../etc", sha256: "a".repeat(64) },
      { session_id: "chatgpt:s1", sha256: "../../../etc/passwd" },
      { session_id: "chatgpt:s1", sha256: "A".repeat(64) },
    ]) expect(handleGetAsset(f.canonicalDir, args).isError).toBe(true);
  } finally { f.cleanup(); }
});

test("get_asset reports a missing session or missing blob as a tool error", () => {
  const f = fixture();
  try {
    expect(handleGetAsset(f.canonicalDir, { session_id: "chatgpt:nope", sha256: "a".repeat(64) }).isError).toBe(true);
    const stored = f.store("s1", PNG, "image/png");
    f.session("s1", [imageBlock(stored, "image/png")]);
    unlinkSync(assetBlobPath(f.canonicalDir, stored.sha256));
    unlinkSync(resolveLocalAssetPath(f.canonicalDir, stored.local_path));
    const res = handleGetAsset(f.canonicalDir, { session_id: "chatgpt:s1", sha256: stored.sha256 });
    expect(res.isError).toBe(true);
    expect(res.content[0]).toMatchObject({ type: "text" });
  } finally { f.cleanup(); }
});

test("get_asset declines assets over the inline size cap but still describes them", () => {
  const f = fixture();
  try {
    const stored = f.store("s1", PNG, "image/png");
    f.session("s1", [imageBlock(stored, "image/png")]);
    const res = handleGetAsset(f.canonicalDir, { session_id: "chatgpt:s1", sha256: stored.sha256 }, { maxBytes: 4 });
    expect(res.isError).toBe(true);
    expect(res.content.some(c => c.type === "image")).toBe(false);
    const text = res.content[0] && "text" in res.content[0] ? res.content[0].text : "";
    expect(text).toContain(String(PNG.byteLength));
  } finally { f.cleanup(); }
});

test("get_asset returns text files as text and other files as an embedded resource", () => {
  const f = fixture();
  try {
    const note = f.store("s1", new TextEncoder().encode("hello notes"), "text/markdown", "notes.md");
    const pdfBytes = new TextEncoder().encode("%PDF-1.4 fake");
    const pdf = f.store("s1", pdfBytes, "application/pdf", "doc.pdf");
    f.session("s1", [
      { type: "file", pointer: "p1", filename: "notes.md", local_path: note.local_path, sha256: note.sha256, mime_type: "text/markdown" },
      { type: "file", pointer: "p2", filename: "doc.pdf", local_path: pdf.local_path, sha256: pdf.sha256, mime_type: "application/pdf" },
    ]);
    const text = handleGetAsset(f.canonicalDir, { session_id: "chatgpt:s1", sha256: note.sha256 });
    expect(text.content.some(c => c.type === "text" && c.text === "hello notes")).toBe(true);
    const res = handleGetAsset(f.canonicalDir, { session_id: "chatgpt:s1", sha256: pdf.sha256 });
    expect(res.content.find(c => c.type === "resource")).toEqual({
      type: "resource",
      resource: { uri: `chat-scrobbler://assets/chatgpt:s1/${pdf.sha256}`, mimeType: "application/pdf", blob: Buffer.from(pdfBytes).toString("base64") },
    });
  } finally { f.cleanup(); }
});

test("get_asset is served over MCP with image content intact", async () => {
  const f = fixture();
  const server = buildServer({ indexPath: ":memory:", canonicalDir: f.canonicalDir });
  const client = new Client({ name: "mcp-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    const stored = f.store("s1", PNG, "image/png");
    f.session("s1", [imageBlock(stored, "image/png")]);
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name)).toContain("get_asset");
    const res = await client.callTool({ name: "get_asset", arguments: { session_id: "chatgpt:s1", sha256: stored.sha256 } });
    expect(res.structuredContent).toBeUndefined();
    expect((res.content as any[]).find(c => c.type === "image")).toMatchObject({ mimeType: "image/png", data: Buffer.from(PNG).toString("base64") });
  } finally { await client.close(); f.cleanup(); }
});
