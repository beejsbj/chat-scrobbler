// test/store.test.ts
import { test, expect, afterAll } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSession, readSession, listSessionFiles, sessionToMarkdown, deleteSession } from "../src/store/sessions";
import { resolveLocalAssetPath, storeCanonicalAsset } from "../src/store/assets";
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

test("deleteSession removes canonical JSON and captured assets for one session", () => {
  const root = mkdtempSync(join(tmpdir(), "sess-delete-"));
  const canonicalDir = join(root, "canonical", "sessions");
  const target = { ...session, source: "chatgpt" as const, source_id: "conv-1", id: "chatgpt:conv-1" };
  try {
    const sessionPath = writeSession(canonicalDir, target);
    const asset = storeCanonicalAsset({
      canonicalDir,
      source: "chatgpt",
      sourceId: "conv-1",
      pointer: "file-service://file-1",
      filename: "pic.png",
      contentType: "image/png",
      bytes: new Uint8Array([1, 2, 3]),
    });
    const assetPath = resolveLocalAssetPath(canonicalDir, asset.local_path);

    const result = deleteSession(canonicalDir, "chatgpt", "conv-1");

    expect(result).toMatchObject({ sessionDeleted: true, assetsDeleted: true });
    expect(existsSync(sessionPath)).toBe(false);
    expect(existsSync(assetPath)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("replacing canonical JSON publishes a new file without changing an existing reader's inode", () => {
  const { linkSync, readFileSync, readdirSync } = require("node:fs");
  const root = mkdtempSync(join(tmpdir(), "session-atomic-"));
  try {
    const file = writeSession(root, session);
    const oldReader = join(root, "old-reader.json");
    linkSync(file, oldReader);
    writeSession(root, { ...session, title: "Updated" });
    expect(JSON.parse(readFileSync(oldReader, "utf8")).title).toBe("Healing");
    expect(readSession(root, "claude", "cl-1").title).toBe("Updated");
    expect(readdirSync(join(root, "claude"))).toEqual(["cl-1.json"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("canonical paths reject traversal while existing safe filenames keep resolving", () => {
  const { writeFileSync, mkdirSync } = require("node:fs");
  const root = mkdtempSync(join(tmpdir(), "session-path-"));
  try {
    for (const source_id of ["../x", "../../x", "/x", "a/b", "a\\b", ".", "..", "nul\u0000"]) {
      expect(() => writeSession(root, { ...session, source_id })).toThrow();
      expect(() => readSession(root, "claude", source_id)).toThrow();
    }
    expect(existsSync(join(root, "x.json"))).toBe(false);
    mkdirSync(join(root, "claude"), { recursive: true });
    const legacy = { ...session, source_id: "legacy.id with spaces" };
    writeFileSync(join(root, "claude", `${legacy.source_id}.json`), JSON.stringify(legacy));
    expect(readSession(root, "claude", legacy.source_id)).toEqual(legacy);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
