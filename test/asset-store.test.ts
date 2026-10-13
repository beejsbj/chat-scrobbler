import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetsDirForCanonicalDir, storeCanonicalAsset, resolveLocalAssetPath } from "../src/store/assets";
import { deleteSession } from "../src/store/sessions";
import { parseChatgpt } from "../src/parsers/chatgpt";
import chatgptApi from "./fixtures/chatgpt-api-sample.json";

test("assets deduplicate across sessions and retain first-seen metadata after local deletion", () => {
  const root = mkdtempSync(join(tmpdir(), "asset-cas-"));
  const canonicalDir = join(root, "canonical", "sessions");
  try {
    const input = { canonicalDir, source: "chatgpt" as const, sourceId: "first", messageId: "m1", pointer: "file-service://a", contentType: "image/png", bytes: new Uint8Array([1, 2, 3]) };
    const first = storeCanonicalAsset(input);
    const second = storeCanonicalAsset({ ...input, sourceId: "second", pointer: "file-service://b" });
    expect(first.sha256).toBe("039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81");
    expect(statSync(resolveLocalAssetPath(canonicalDir, first.local_path)).ino).toBe(statSync(resolveLocalAssetPath(canonicalDir, second.local_path)).ino);
    const blob = join(assetsDirForCanonicalDir(canonicalDir), "sha256", first.sha256.slice(0, 2), first.sha256);
    expect(readFileSync(`${blob}.json`, "utf8") && JSON.parse(readFileSync(`${blob}.json`, "utf8"))).toMatchObject({ sha256: first.sha256, mime: "image/png", size_bytes: 3, original_pointer: "file-service://a", first_seen: { session_id: "chatgpt:first", message_id: "m1" } });
    deleteSession(canonicalDir, "chatgpt", "first");
    expect(existsSync(blob)).toBe(true);
    expect(existsSync(resolveLocalAssetPath(canonicalDir, second.local_path))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("canonical attachments carry the uploaded hash without requiring it in legacy captures", () => {
  const capture = { ...chatgptApi, payload: { ...chatgptApi.payload, mapping: { image: { id: "image", parent: null, children: [], message: { id: "image", author: { role: "user" }, content: { content_type: "multimodal_text", parts: [{ content_type: "image_asset_pointer", asset_pointer: "file-service://a" }] } } } } }, assets: [{ pointer: "file-service://a", local_path: "assets/a.png", sha256: "a".repeat(64) }] };
  const [session] = parseChatgpt(capture);
  expect(session.messages[0].blocks[0]).toMatchObject({ type: "attachment", sha256: "a".repeat(64) });
});
