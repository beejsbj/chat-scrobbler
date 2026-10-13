import { test, expect } from "bun:test";
import { parseChatgpt } from "../src/parsers/chatgpt";
import { parseClaude } from "../src/parsers/claude";
import { parseGemini } from "../src/parsers/gemini";
import chatgpt from "./fixtures/chatgpt-api-sample.json";
import claude from "./fixtures/claude-api-sample.json";
import gemini from "./fixtures/gemini-api-sample.json";

const budget = 64 * 1024;
test("all parsers bound total inline unknown JSON per session across messages", () => {
  const opaque = { type: "future_visual", data: "界".repeat(4000) }; // less than 16 KiB per fragment
  const gpt = structuredClone(chatgpt) as any;
  gpt.payload.mapping.n1.message.content.parts.push(...Array(6).fill(opaque));
  gpt.payload.mapping.n3.message.content.parts.push(...Array(6).fill(opaque));
  const cl = structuredClone(claude) as any;
  cl.payload.chat_messages[0].content.push(...Array(6).fill(opaque));
  cl.payload.chat_messages[1].content.push(...Array(6).fill(opaque));
  const gm = structuredClone(gemini) as any;
  gm.payload[0][0][2][0].push(...Array(6).fill(opaque));
  gm.payload[0][1][3][0][0][1].push(...Array(6).fill(opaque));
  for (const session of [parseChatgpt(gpt, { raw_ref: "version" })[0], parseClaude(cl, { raw_ref: "version" })[0], parseGemini(gm, { raw_ref: "version" })[0]]) {
    const blocks = session.messages.flatMap(m => m.blocks).filter(b => b.type === "unknown");
    expect(blocks).toHaveLength(12);
    const inlineBytes = blocks.reduce((bytes, block) => bytes + (block.raw_json === null ? 0 : Buffer.byteLength(JSON.stringify(block.raw_json), "utf8")), 0);
    expect(inlineBytes).toBeLessThanOrEqual(budget);
    expect(blocks.some(b => b.raw_json !== null)).toBe(true);
    expect(blocks.some(b => b.raw_json === null && b.truncated)).toBe(true);
    expect(blocks.every(b => b.raw_ref === "version" && b.raw_path.startsWith("/payload/") && b.size_bytes > 12000)).toBe(true);
  }
});
