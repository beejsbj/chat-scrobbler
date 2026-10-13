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
