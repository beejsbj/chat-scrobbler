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
        { type: "hidden", matched_text: "" },
        { type: "alt_text", matched_text: "Answer x", alt: "x", prompt_text: "x" },
        { type: "map", matched_text: "", entities: [{ id: "e1", name: "Cafe", entity: { address: "1 Main St", website_url: "https://cafe.example.org" } }] },
        { type: "client_defined_widget", matched_text: "z".repeat(40), data: { widget_type: "app_block", content: "y".repeat(30) } },
        { type: "brand_new_reference", payload: 1 }],
      attachments: [{ id: "file-up1", name: "a.png", mime_type: "image/png" }] };
    const cl = structuredClone(claude) as any;
    cl.payload.chat_messages[1].content.push(
      { type: "token_budget" },
      { type: "text", text: "cited", citations: [{ uuid: "c1", title: "T", url: "https://example.org/c", start_index: 0, end_index: 1, metadata: { type: "webpage_metadata" } }] });
    const gem = structuredClone(gemini) as any;
    gem.payload[0][0][2][0].push([[]]);
    gem.payload[0][0][2][6] = 2;
    const candidate = gem.payload[0][0][3][0][0];
    candidate[37] = [["**Plan**\n\nThink."], [[["**Plan**\n\nThink."], "", "", "", [], "Plan", "Think."]]];
    candidate[2] = [null, [[["q", null, null, []], [1], [["https://example.org/g", "Source", "icon", "snippet"]], "x"]]];
    gem.payload[0][0][3][31] = "model-id-1";
    gem.payload[0][0][3][4] = [[null, ["search", [null, null, "Web search", "https://icon.example.org/i.png"], 1]]];
    gem.payload[0][0][2][0][4] = [[null, null, null, null, [[null, 11, "doc.pdf", null, null, "tok", null, ["https://lh3.googleusercontent.com/a"]]]]];
    gem.payload[3] = [[[["https://example.org/new"]]]];
    for (const capture of [gpt, cl, gem]) {
      storeRawCapture(join(root, "raw"), capture);
      const session = readFromParser(capture);
      session.messages.at(-1)!.blocks.push(stale("old_unknown"));
      writeSession(opts.canonicalDir, session);
    }
    // old_unknown per provider, plus the two sentinel types nobody has classified
    expect(unknownTypes(opts.canonicalDir).counts).toHaveLength(5);
    expect(await reparse(opts)).toMatchObject({ changed: 3, failed: 0 });
    // Only the types nobody has seen are left; every classified one is gone.
    expect(unknownTypes(opts.canonicalDir).counts).toEqual([
      { source: "chatgpt", provider_type: "brand_new_reference", count: 1 },
      { source: "gemini", provider_type: "gemini.payload.content", count: 1 }]);
    const gemini2 = readSession(opts.canonicalDir, "gemini", gem.source_id);
    expect(gemini2.messages.flatMap(m => m.blocks).map(b => b.type)).toEqual(expect.arrayContaining(["reasoning", "citation", "file"]));
    const rebuilt = readSession(opts.canonicalDir, "chatgpt", gpt.source_id);
    expect(rebuilt.messages.at(-1)!.blocks.some(b => b.type === "citation" && b.url === "https://example.org/p")).toBe(true);
    expect(rebuilt.messages.at(-1)!.text).toContain("https://example.org/p");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);

const readFromParser = (capture: any) => getParser(capture.source, capture.capture_method)(capture, { raw_ref: "old" })[0];
