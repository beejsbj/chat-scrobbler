import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { unknownTypes } from "../src/core/unknown-types";
import { writeSession } from "../src/store/sessions";
import { markSessionDeleted } from "../src/store/tombstones";
import { parseClaude } from "../src/parsers/claude";
import fixture from "./fixtures/claude-api-sample.json";

test("unknown report counts every branch, skips deleted sessions, and ignores unreadable sessions entirely", () => {
  const root = mkdtempSync(join(tmpdir(), "unknown-types-"));
  try {
    const session = parseClaude(fixture)[0];
    const block = { type: "unknown" as const, provider_type: "__proto__", raw_json: null, raw_ref: "raw", raw_path: "/payload", truncated: true, size_bytes: 20000 };
    session.messages[0].blocks.push(block);
    session.messages[1].blocks.push(block);
    session.active_leaf_id = session.messages[0].id;
    writeSession(root, session);
    const bad = { ...session, id: "claude:bad", source_id: "bad" };
    const badFile = writeSession(root, bad);
    writeFileSync(badFile, JSON.stringify({ ...bad, messages: [session.messages[0], { blocks: null }] }));
    const deleted = { ...session, id: "claude:deleted", source_id: "deleted" };
    writeSession(root, deleted);
    markSessionDeleted(root, { source: "claude", source_id: "deleted", deleted_at: "2026-10-13T00:00:00Z" });
    expect(unknownTypes(root)).toEqual({ scanned_sessions: 1, unreadable_sessions: 1,
      counts: [{ source: "claude", provider_type: "__proto__", count: 2 }] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
