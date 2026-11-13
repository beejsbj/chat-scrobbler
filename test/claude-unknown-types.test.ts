// Synthetic Claude content shapes the monitor used to report as unknown. Values are invented.
import { test, expect } from "bun:test";
import { parseClaude } from "../src/parsers/claude";
import sample from "./fixtures/claude-api-sample.json";

function parseWith(mutate: (message: any) => void, extra: Record<string, unknown> = {}) {
  const capture = structuredClone(sample) as any;
  const message = capture.payload.chat_messages[1];
  mutate(message);
  Object.assign(capture, extra);
  const [session] = parseClaude(capture, { raw_ref: "claude/cl-1/v1.json.gz" });
  return session.messages[1];
}
const unknownTypes = (message: { blocks: any[] }) => message.blocks.filter(b => b.type === "unknown").map(b => b.provider_type);
const webCitation = (url: string, title: string) => ({ uuid: "c-" + url.length, title, url, start_index: 0, end_index: 5,
  metadata: { type: "webpage_metadata", site_domain: "example.org", favicon_url: "https://example.org/f.ico", site_name: "Example" },
  origin_tool_name: "web_search", sources: [{ title, url, icon_url: "https://example.org/f.ico", source: "Example", uuid: "s-1" }] });

test("web-client citations without a type become deduplicated citation blocks", () => {
  const message = parseWith(m => {
    m.content[1].citations = [webCitation("https://example.org/a", "Page A"), webCitation("https://example.org/a", "Page A"),
      webCitation("https://example.org/b", "Page B")];
  });
  expect(unknownTypes(message)).toEqual([]);
  expect(message.blocks.filter(b => b.type === "citation")).toEqual([
    { type: "citation", provider_type: "webpage_metadata", url: "https://example.org/a", title: "Page A", text: null },
    { type: "citation", provider_type: "webpage_metadata", url: "https://example.org/b", title: "Page B", text: null },
  ]);
  expect(message.text).toContain("https://example.org/b");
});

test("a citation with no url or an unfamiliar shape still alerts", () => {
  const message = parseWith(m => { m.content[1].citations = [{ uuid: "x", title: "No link" }, { type: "future_location", payload: 1 }]; });
  expect(unknownTypes(message)).toEqual(["citation", "future_location"]);
});

test("image content with a file uuid becomes an image block and is not duplicated by files_v2", () => {
  const message = parseWith(m => {
    m.content.push({ type: "image", file_uuid: "file-1", start_timestamp: "2025-01-01T00:00:00Z", stop_timestamp: "2025-01-01T00:00:00Z" });
    m.files_v2 = [{ file_uuid: "file-1", file_name: "shot.png", mime_type: "image/png" }];
  }, { assets: [{ pointer: "file-1", local_path: "assets/claude/cl-1/shot.png", message_id: "m2", filename: "shot.png", content_type: "image/png", sha256: "a".repeat(64) }] });
  expect(unknownTypes(message)).toEqual([]);
  const images = message.blocks.filter(b => b.type === "image");
  expect(images).toHaveLength(1);
  expect(images[0]).toMatchObject({ pointer: "file-1", local_path: "assets/claude/cl-1/shot.png", mime_type: "image/png" });
});

test("an image block keeps the filename and type from files_v2 when no asset was captured", () => {
  const message = parseWith(m => {
    m.content.push({ type: "image", file_uuid: "file-2" });
    m.files_v2 = [{ file_uuid: "file-2", file_name: "shot.png", mime_type: "image/png" }];
  });
  expect(message.blocks.filter(b => b.type === "image")).toEqual([expect.objectContaining({ pointer: "file-2", filename: "shot.png", mime_type: "image/png" })]);
  expect(message.text).toContain("[image: shot.png]");
});

test("image content without a pointer stays unknown", () => {
  const message = parseWith(m => { m.content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }); });
  expect(unknownTypes(message)).toEqual(["image"]);
});

test("token_budget and flag are known and ignored", () => {
  const message = parseWith(m => {
    m.content.push({ type: "token_budget", flags: null, remaining: null }, { type: "token_budget" },
      { type: "flag", flag: "some_flag", helpline: { id: "h1", name: "Line", phone_number: "000" } });
  });
  expect(unknownTypes(message)).toEqual([]);
  expect(message.blocks.map(b => b.type)).toEqual(["reasoning", "text", "artifact"]);
});

test("artifact tool_use with a partial edit or no body keeps what it carries and no longer alerts", () => {
  const message = parseWith(m => {
    m.content.push(
      { type: "tool_use", name: "artifacts", input: { id: "a2", type: "text/markdown", title: "Draft", command: "create", version_uuid: "v1" } },
      { type: "tool_use", name: "artifacts", input: { id: "a2", command: "update", new_str: "added text", version_uuid: "v2" } },
      { type: "tool_use", name: "artifacts", input: { id: "a2", command: "update", old_str: "removed text", version_uuid: "v3" } });
  });
  expect(unknownTypes(message)).toEqual([]);
  const artifacts = message.blocks.filter(b => b.type === "artifact") as any[];
  expect(artifacts.slice(1).map(a => [a.artifact_id, a.title, a.operation, a.content, a.edits])).toEqual([
    ["a2", "Draft", "create", "", undefined],
    ["a2", "Draft", "update", "", [{ old_str: "", new_str: "added text" }]],
    ["a2", "Draft", "update", "", [{ old_str: "removed text", new_str: "" }]],
  ]);
});

test("an artifact tool_use with an unrecognized body still alerts", () => {
  const message = parseWith(m => { m.content.push({ type: "tool_use", name: "artifacts", input: { id: "a3", command: "mystery", payload: [1] } }); });
  expect(unknownTypes(message)).toEqual(["tool_use"]);
});

test("an unfamiliar content type still alerts", () => {
  expect(unknownTypes(parseWith(m => { m.content.push({ type: "brand_new_block", data: 1 }); }))).toEqual(["brand_new_block"]);
});
