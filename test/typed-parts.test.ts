import { test, expect } from "bun:test";
import { renderText } from "../src/parsers/render";
import type { Block } from "../src/schema/types";

test("recall renders typed media and citations but never tool payloads or unknown JSON", () => {
  const blocks: Block[] = [
    { type: "image", pointer: "provider-image", filename: "chart.png", local_path: null, sha256: "a".repeat(64) },
    { type: "audio", pointer: "provider-audio", filename: null, local_path: null },
    { type: "video", pointer: "provider-video", filename: null, local_path: null },
    { type: "file", pointer: "provider-file", filename: "notes.pdf", local_path: null },
    { type: "citation", provider_type: "web", url: "https://example.org", title: "Reference", text: null },
    { type: "ui_widget", kind: "chart", pointer: "provider-widget" },
    { type: "unknown", provider_type: "future", raw_json: { secret: "opaque-noise" }, raw_ref: "version.json.gz", raw_path: "/payload", truncated: false, size_bytes: 25 },
    { type: "tool_call", name: "python", tool_type: "python", input: "input-noise" },
    { type: "tool_result", name: "python", output: "output-noise" },
  ];
  const text = renderText(blocks);
  expect(text).toContain("[image: chart.png]");
  expect(text).toContain("[audio]");
  expect(text).toContain("[video]");
  expect(text).toContain("[file: notes.pdf]");
  expect(text).toContain("Reference");
  expect(text).toContain("[ui: chart]");
  expect(text).toContain("python");
  expect(text).not.toContain("noise");
});
