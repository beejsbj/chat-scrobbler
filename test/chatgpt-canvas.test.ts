import { expect, test } from "bun:test";
import { parseChatgpt } from "../src/parsers/chatgpt";
import { indexSession, openIndex, searchMessages } from "../src/indexer/sqlite";

function canvasCapture(calls: Array<{ name: string; input: unknown }>) {
  const mapping: Record<string, any> = {};
  calls.forEach(({ name, input }, i) => {
    mapping[`m${i}`] = { id: `m${i}`, parent: i ? `m${i - 1}` : null,
      children: i + 1 < calls.length ? [`m${i + 1}`] : [], message: {
        id: `m${i}`, author: { role: "assistant" }, recipient: name,
        content: { content_type: "code", language: "json", text: JSON.stringify(input) },
      } };
  });
  return { payload: { conversation_id: "canvas", current_node: `m${calls.length - 1}`, mapping } };
}

test("Canvas creates searchable document and code artifacts, preserving tool classification", () => {
  for (const [providerType, kind, language] of [["document", "document", null], ["code/python", "code", "python"]]) {
    const capture = canvasCapture([{ name: "canmore.create_textdoc", input: {
      name: "Canvas notebook", type: providerType, content: "luminous manuscript",
    } }]);
    const session = parseChatgpt(capture)[0];
    const message = session.messages[0];
    expect(message.blocks).toContainEqual(expect.objectContaining({ type: "artifact", artifact_id: "m0",
      title: "Canvas notebook", kind, language, content: "luminous manuscript", operation: "create", version: null }));
    expect(message.blocks[0]).toEqual({ type: "tool_call", name: "canmore.create_textdoc", tool_type: "canvas" });
    expect(message.text).toContain("Canvas notebook\nluminous manuscript");
    expect(message.text).not.toContain('"content":');
    const db = openIndex(":memory:");
    try {
      indexSession(db, session);
      expect(searchMessages(db, "luminous").map(hit => hit.message_id)).toEqual(["m0"]);
    } finally { db.close(); }
  }
});

test("Canvas updates and comments retain patterns while their user-facing text enters recall", () => {
  const capture = canvasCapture([
    { name: "canmore.create_textdoc", input: { name: "Notebook", type: "code/python", content: "original body" } },
    { name: "canmore.update_textdoc", input: { updates: [
      { pattern: "privatepattern.*", multiple: true, replacement: "iridescent replacement" },
      { pattern: "otherpattern", replacement: "additional prose" },
    ] } },
    { name: "canmore.comment_textdoc", input: { comments: [{ pattern: "privatepattern", comment: "consider chrysanthemum" }] } },
  ]);
  const session = parseChatgpt(capture)[0];
  expect(session.messages[1].blocks).toContainEqual(expect.objectContaining({ type: "artifact", artifact_id: "m0",
    title: "Notebook", kind: "code", language: "python", operation: "update", version: null,
    content: "iridescent replacement\nadditional prose", updates: [
      { pattern: "privatepattern.*", multiple: true, replacement: "iridescent replacement" },
      { pattern: "otherpattern", replacement: "additional prose" },
    ] }));
  expect(session.messages[2].blocks).toContainEqual(expect.objectContaining({ type: "artifact", artifact_id: "m0",
    title: "Notebook", kind: "code", language: "python", operation: "comment", content: "consider chrysanthemum",
    comments: [{ pattern: "privatepattern", comment: "consider chrysanthemum" }] }));
  const db = openIndex(":memory:");
  try {
    indexSession(db, session);
    expect(searchMessages(db, "iridescent").map(hit => hit.message_id)).toEqual(["m1"]);
    expect(searchMessages(db, "chrysanthemum").map(hit => hit.message_id)).toEqual(["m2"]);
    expect(searchMessages(db, "privatepattern")).toEqual([]);
  } finally { db.close(); }
});

test("Canvas context follows ancestors without leaking titles between sibling branches", () => {
  const capture = canvasCapture([
    { name: "canmore.create_textdoc", input: { name: "First document", type: "document", content: "body" } },
    { name: "canmore.create_textdoc", input: { name: "Sibling document", type: "code/javascript", content: "code" } },
    { name: "canmore.update_textdoc", input: { updates: [{ pattern: ".*", replacement: "revised" }] } },
  ]);
  capture.payload.mapping.m0.children = ["m1", "m2"];
  capture.payload.mapping.m1.children = [];
  capture.payload.mapping.m2.parent = "m0";
  const message = parseChatgpt(capture)[0].messages[2];
  expect(message.blocks).toContainEqual(expect.objectContaining({ type: "artifact", artifact_id: "m0",
    title: "First document", kind: "document", language: null, content: "revised" }));
});

test("Canvas updates without a captured create keep content and edits without guessing title or kind", () => {
  const capture = canvasCapture([{ name: "canmore.update_textdoc", input: {
    updates: [{ pattern: ".*", replacement: "standalone replacement" }],
  } }]);
  // Text-part envelopes also carry serialized Canvas arguments.
  const content = capture.payload.mapping.m0.message.content;
  capture.payload.mapping.m0.message.content = { content_type: "text", parts: [content.text] };
  const message = parseChatgpt(capture)[0].messages[0];
  expect(message.blocks).toContainEqual(expect.objectContaining({ type: "artifact", title: null,
    kind: "", language: null, content: "standalone replacement", updates: [{ pattern: ".*", replacement: "standalone replacement" }] }));
  expect(message.text).toContain("standalone replacement");
});

test("malformed or unfamiliar Canvas calls retain an unknown raw fragment instead of inventing an artifact", () => {
  for (const [name, input] of [
    ["canmore.create_textdoc", { name: "Future", type: "slides", content: "body" }],
    ["canmore.update_textdoc", { updates: [{ future_edit: "opaque" }] }],
    ["canmore.comment_textdoc", { comments: [{ pattern: ".*", comment: 42 }] }],
    ["canmore.future_textdoc", { future_content: "opaque" }],
  ]) {
    const capture = canvasCapture([{ name: name as string, input }]);
    const message = parseChatgpt(capture, { raw_ref: "canvas-version" })[0].messages[0];
    expect(message.blocks).toContainEqual(expect.objectContaining({ type: "unknown", raw_ref: "canvas-version",
      raw_path: "/payload/mapping/m0/message/content", raw_json: capture.payload.mapping.m0.message.content }));
    expect(message.blocks.some(block => block.type === "artifact")).toBe(false);
  }
  const capture = canvasCapture([{ name: "canmore.create_textdoc", input: null }]);
  capture.payload.mapping.m0.message.content.text = "invalid JSON";
  expect(parseChatgpt(capture)[0].messages[0].blocks).toContainEqual(expect.objectContaining({ type: "unknown" }));
});
