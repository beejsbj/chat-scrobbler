// Reparse over archived raw takes the new parsing paths: an old canonical session that
// reported these types as unknown is rebuilt from raw without them.
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reparse } from "../src/core/reparse";
import { unknownTypes } from "../src/core/unknown-types";
import { getParser } from "../src/parsers/registry";
import { storeRawCapture } from "../src/store/raw";
import { readSession, writeSession } from "../src/store/sessions";
import chatgpt from "./fixtures/chatgpt-api-sample.json";
import claude from "./fixtures/claude-api-sample.json";
import gemini from "./fixtures/gemini-api-sample.json";

const stale = (provider_type: string) => ({ type: "unknown" as const, provider_type, raw_json: null, raw_ref: "old", raw_path: "/payload", truncated: true, size_bytes: 20000 });

test("reparse replaces stale unknown blocks for every provider and leaves new types alerting", async () => {
  const root = mkdtempSync(join(tmpdir(), "reparse-unknown-"));
  const opts = { canonicalDir: join(root, "canonical", "sessions"), indexPath: join(root, "index.db") };
  try {
    const gpt = structuredClone(chatgpt) as any;
    const message = gpt.payload.mapping.n3.message;
    message.metadata = { model_slug: "gpt-4",
      content_references: [
        { type: "grouped_webpages", matched_text: "x", items: [{ title: "Page", url: "https://example.org/p" }] },
        { type: "hidden", matched_text: "" }, { type: "alt_text", matched_text: "x", alt: "still unknown" }],
      attachments: [{ id: "file-up1", name: "a.png", mime_type: "image/png" }] };
    const cl = structuredClone(claude) as any;
    cl.payload.chat_messages[1].content.push(
      { type: "token_budget" },
      { type: "text", text: "cited", citations: [{ uuid: "c1", title: "T", url: "https://example.org/c", start_index: 0, end_index: 1, metadata: { type: "webpage_metadata" } }] });
    const gem = structuredClone(gemini) as any;
    gem.payload[0][0][2][0].push([[]]);
    gem.payload[0][0][2][6] = 2;
    for (const capture of [gpt, cl, gem]) {
      storeRawCapture(join(root, "raw"), capture);
      const session = readFromParser(capture);
      session.messages.at(-1)!.blocks.push(stale("old_unknown"));
      writeSession(opts.canonicalDir, session);
    }
    expect(unknownTypes(opts.canonicalDir).counts).toHaveLength(4); // old_unknown per provider, plus alt_text
    expect(await reparse(opts)).toMatchObject({ changed: 3, failed: 0 });
    // Only alt_text is left: the one type in these captures the parser cannot classify.
    expect(unknownTypes(opts.canonicalDir).counts).toEqual([{ source: "chatgpt", provider_type: "alt_text", count: 1 }]);
    const rebuilt = readSession(opts.canonicalDir, "chatgpt", gpt.source_id);
    expect(rebuilt.messages.at(-1)!.blocks.some(b => b.type === "citation" && b.url === "https://example.org/p")).toBe(true);
    expect(rebuilt.messages.at(-1)!.text).toContain("https://example.org/p");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);

const readFromParser = (capture: any) => getParser(capture.source, capture.capture_method)(capture, { raw_ref: "old" })[0];
