import { expect, test } from "bun:test";
import { createChatgptAdapter } from "../packages/extension/src/providers/chatgpt";
import { parseChatgpt } from "../src/parsers/chatgpt";

test("web thumbnail image_url remains raw reference without asset failure or unavailable media block", async () => {
  const url = "https://news.example/thumbnail.jpg";
  const payload = { conversation_id: "c", mapping: { m: { id: "m", parent: null, children: [], message: {
    id: "m", author: { role: "assistant" }, content: { content_type: "text", parts: ["Article"] },
    metadata: { aggregate_result: { messages: [{ image_url: url }] } },
  } } } };
  let raw: any;
  const calls: string[] = [];
  await createChatgptAdapter(async input => {
    calls.push(input);
    return Response.json(input === "/api/auth/session" ? {} : payload);
  }).captureOne!("c", null, { emitCapture: async capture => { raw = capture; }, uploadAsset: async () => { throw new Error("must not upload"); } });
  expect(calls).toEqual(["/api/auth/session", "/backend-api/conversation/c"]);
  expect(raw.asset_references).toEqual([]);
  expect(raw.payload.mapping.m.message.metadata.aggregate_result.messages[0].image_url).toBe(url);
  const [session] = parseChatgpt(raw);
  expect(session.messages[0].blocks.filter(b => "local_path" in b)).toEqual([]);
});
