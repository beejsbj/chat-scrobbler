import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { canonicalObservations } from "../src/monitor/canonical";
import { writeSession } from "../src/store/sessions";
import type { Message, Session } from "../src/schema/types";

const dayMs = 24 * 3_600_000;
const now = Date.parse("2026-11-01T12:00:00Z");
const since = now - 2 * dayMs;
const iso = (offsetDays: number) => new Date(now + offsetDays * dayMs).toISOString();

const image = (pointer: string) => ({ type: "image" as const, pointer, filename: null, local_path: null, sha256: null, mime_type: null });
function message(id: string, createdDays: number | null, pointer?: string): Message {
  return { id, role: "assistant", created_at: createdDays === null ? null : iso(createdDays), parent_id: null, model: null,
    blocks: pointer ? [image(pointer)] : [{ type: "text", text: "hi" }], text: "" };
}
function session(over: Partial<Session> & { messages: Message[] }): Session {
  return { id: "gemini:s1", source: "gemini", source_id: "s1", capture_method: "api", title: null, created_at: iso(-90), updated_at: iso(0),
    default_model: null, account: null, raw_ref: "raw", schema_version: 2, ...over };
}
function observe(sessions: Session[], ignored?: Parameters<typeof canonicalObservations>[2]) {
  const root = mkdtempSync(join(import.meta.dir, ".recent-blocks-"));
  try {
    const dir = join(root, "canonical", "sessions");
    for (const s of sessions) writeSession(dir, s);
    return canonicalObservations(dir, since, ignored).missingAssets;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("an old missing image in a chat touched today does not alert", () => {
  expect(observe([session({ messages: [message("old", -60, "p-old"), message("new", 0)] })])).toBe(0);
});

test("a missing image on a message created inside the window alerts, one per block", () => {
  expect(observe([session({ messages: [message("old", -60, "p-old"), message("new", -0.5, "p-new")] })])).toBe(1);
});

test("a message with no timestamp takes the time of the next timestamped message", () => {
  // Gemini user turns carry no timestamp; the reply that follows does.
  expect(observe([session({ messages: [message("u1", null, "p-old"), message("a1", -60), message("u2", null, "p-new"), message("a2", -0.5)] })])).toBe(1);
});

test("a message with no timestamp and none after it falls back to the session's creation time", () => {
  expect(observe([session({ messages: [message("a", -60), message("u", null, "p")] })])).toBe(0);
  expect(observe([session({ created_at: iso(-1), messages: [message("u", null, "p")] })])).toBe(1);
});

test("an asset the owner ignored does not count, a different one still does", () => {
  const messages = [message("m1", -0.5, "p-ignored"), message("m2", -0.5, "p-open")];
  const ignored = (source: string) => new Set(source === "gemini" ? [JSON.stringify(["s1", "m1", "p-ignored"])] : []);
  expect(observe([session({ messages })], ignored)).toBe(1);
});
