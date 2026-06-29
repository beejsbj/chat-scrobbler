// test/gemini-api.test.ts
// Unit tests for the Gemini api parser (src/parsers/gemini.ts).
// All inputs come from a captured fixture based on real live data (2026-06-06).
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGemini } from "../src/parsers/gemini";
import { foldCaptureIntoSpine } from "../packages/ingest/src/pipeline";
import { openIndex, searchMessages } from "../src/indexer/sqlite";
import type { RawCapture } from "../packages/shared/src";
import sample from "./fixtures/gemini-api-sample.json";

// ---------------------------------------------------------------------------
// Parser unit tests
// ---------------------------------------------------------------------------

test("parses a Gemini hNvQHb capture (RawCapture envelope) into a canonical session", () => {
  const [s] = parseGemini(sample);
  expect(s.id).toBe("gemini:98a3d78ec6ddbe15");
  expect(s.source).toBe("gemini");
  expect(s.capture_method).toBe("api");
  expect(s.source_id).toBe("98a3d78ec6ddbe15");
  expect(s.schema_version).toBe(1);
  expect(s.raw_ref).toBe("raw/api/gemini:98a3d78ec6ddbe15");
});

test("produces interleaved user/assistant messages in correct order", () => {
  const [s] = parseGemini(sample);
  // 2 turns -> 2 user + 2 assistant = 4 messages
  expect(s.messages).toHaveLength(4);
  expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
});

test("extracts user message text from turn userMeta field", () => {
  const [s] = parseGemini(sample);
  expect(s.messages[0].role).toBe("user");
  expect(s.messages[0].text).toBe("Elliott Beewick");
  expect(s.messages[0].blocks[0]).toMatchObject({ type: "text", text: "Elliott Beewick" });
  expect(s.messages[2].text).toContain("Albert Bix");
});

test("extracts assistant message text from first response candidate", () => {
  const [s] = parseGemini(sample);
  const firstAssistant = s.messages[1];
  expect(firstAssistant.role).toBe("assistant");
  expect(firstAssistant.text).toContain("Elliot Bewick");
  expect(firstAssistant.text).toContain("Next Generation Podcast");

  const secondAssistant = s.messages[3];
  expect(secondAssistant.role).toBe("assistant");
  expect(secondAssistant.text).toContain("Alberti");
  expect(secondAssistant.text).toContain("linear perspective");
});

test("sets assistant message IDs from rc_ candidate ids", () => {
  const [s] = parseGemini(sample);
  expect(s.messages[1].id).toBe("rc_43497dc6bfdf1e0a");
  expect(s.messages[3].id).toBe("rc_68120658a0a33582");
});

test("sets user message IDs from r_ refs", () => {
  const [s] = parseGemini(sample);
  expect(s.messages[0].id).toBe("r_0336cee8638641d7");
  expect(s.messages[2].id).toBe("r_2c112abbc65a17c3");
});

test("extracts model from turn respData position 21", () => {
  const [s] = parseGemini(sample);
  expect(s.default_model).toBe("3.5 Flash");
  // Each assistant message carries the model
  expect(s.messages[1].model).toBe("3.5 Flash");
  expect(s.messages[3].model).toBe("3.5 Flash");
});

test("derives updated_at from last assistant turn timestamp", () => {
  const [s] = parseGemini(sample);
  // turn[1][4] = [1780781180, 758869000] => 2026-06-06T...
  const expected = new Date(1780781180 * 1000).toISOString();
  expect(s.updated_at).toBe(expected);
});

test("derives created_at from first assistant turn timestamp", () => {
  const [s] = parseGemini(sample);
  // turn[0][4] = [1780781169, 226983000]
  const expected = new Date(1780781169 * 1000).toISOString();
  expect(s.created_at).toBe(expected);
});

test("title is null (hNvQHb payload does not include it)", () => {
  const [s] = parseGemini(sample);
  expect(s.title).toBeNull();
});

test("returns [] for null or empty input", () => {
  expect(parseGemini(null)).toEqual([]);
  expect(parseGemini({})).toEqual([]);
  expect(parseGemini({ payload: null })).toEqual([]);
  expect(parseGemini({ payload: [], source_id: "" })).toEqual([]);
});

test("returns [] when source_id is missing from envelope", () => {
  const noId = { ...sample, source_id: undefined };
  expect(parseGemini(noId)).toEqual([]);
});

test("skips turns with no user text or no assistant candidates", () => {
  // Build a payload with two valid turns and one broken turn inserted in between.
  // The real payload[0] is already a two-element array of valid turns.
  const validTurns = (sample.payload as unknown[])[0] as unknown[];
  const badTurn = [null, null, null, [[], null, null, null], null];
  const payloadWithBad = [[...validTurns, badTurn], null, null, []];
  const broken = { ...sample, payload: payloadWithBad };
  const [s] = parseGemini(broken);
  // 2 valid turns still produce user+assistant pairs; bad turn is skipped.
  expect(s.messages.length).toBeGreaterThanOrEqual(2);
});

test("adds Gemini uploaded asset sidecar records as attachment blocks", () => {
  const [s] = parseGemini({
    ...sample,
    assets: [{
      pointer: "https://gemini.google.com/blob/asset-1",
      local_path: "assets/gemini/98a3d78ec6ddbe15/hash.png",
      filename: "image.png",
      content_type: "image/png",
      message_id: "r_0336cee8638641d7",
    }],
  });

  expect(s.messages[0].blocks).toContainEqual(expect.objectContaining({
    type: "attachment",
    kind: "image",
    filename: "image.png",
    pointer: "https://gemini.google.com/blob/asset-1",
    local_path: "assets/gemini/98a3d78ec6ddbe15/hash.png",
  }));
  expect(s.messages[0].text).toContain("assets/gemini/98a3d78ec6ddbe15/hash.png");
});

// ---------------------------------------------------------------------------
// Integration test: fold into spine + assert searchable
// ---------------------------------------------------------------------------

test("Gemini capture folds into canonical + index and is searchable", () => {
  const root = mkdtempSync(join(tmpdir(), "gemini-ingest-"));
  const canonicalDir = join(root, "canonical", "sessions");
  const indexPath = join(root, "index", "sessions.db");
  mkdirSync(join(root, "index"), { recursive: true });
  const db = openIndex(indexPath);
  try {
    const capture = sample as unknown as RawCapture;
    const results = foldCaptureIntoSpine(capture, { canonicalDir, db });

    expect(results).toHaveLength(1);
    expect(results[0].session_id).toBe("gemini:98a3d78ec6ddbe15");
    expect(results[0].indexed).toBe(true);

    // The phrase "Elliot Bewick" appears in assistant message of turn 0.
    const hits = searchMessages(db, "Elliot Bewick");
    expect(hits.length).toBeGreaterThan(0);

    // "Alberti" appears in assistant message of turn 1.
    const hits2 = searchMessages(db, "Alberti");
    expect(hits2.length).toBeGreaterThan(0);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
