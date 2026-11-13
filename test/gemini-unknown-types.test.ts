// Gemini fallback labels: empty positional slots are not content, real unparsed slots still alert.
import { test, expect } from "bun:test";
import { parseGemini } from "../src/parsers/gemini";
import sample from "./fixtures/gemini-api-sample.json";

function parseWith(mutate: (turn: any[], capture: any) => void) {
  const capture = structuredClone(sample) as any;
  mutate(capture.payload[0][0], capture);
  const [session] = parseGemini(capture, { raw_ref: "gemini/id/v1.json.gz" });
  return session;
}
const unknowns = (session: { messages: Array<{ blocks: any[] }> }) =>
  session.messages.flatMap(m => m.blocks).filter(b => b.type === "unknown");

test("all-null and empty nested slots in the user text row are not reported", () => {
  const session = parseWith(turn => { turn[2][0].push(null, [[]], [[null, null, null, null, null]], [[null, [], null, null, null]]); });
  expect(unknowns(session)).toEqual([]);
  expect(session.messages[0].text).toBe("Elliott Beewick");
});

test("positional slots that are all null, or a bare number or boolean, are not reported", () => {
  const session = parseWith((turn, capture) => {
    turn[2][6] = 3;                                         // user slot
    turn[2][10] = [null, null, null, null, null, null, null, null, null, null, null, null];
    turn[3][9] = true;                                      // response slot
    turn[3][0][0][12] = [null, null, null, null, null, null, null, null];
    capture.payload[5] = 7;                                 // payload slot
  });
  expect(unknowns(session)).toEqual([]);
});

test("a slot with real content, or a string, is still reported with its fallback label", () => {
  const session = parseWith((turn, capture) => {
    turn[2][10] = [null, null, ["file-like", "provider://upload"]];
    turn[3][4] = [[null, ["abcdef", [null, null, "x"], 1]]];
    turn[3][0][0][2] = [null, [[["text", null, null], [1], [["https://example.org/x", "Title"]]]]];
    turn[3][31] = "opaque-string";
    capture.payload[3] = [[[["https://example.org/y"]]]];
  });
  expect(unknowns(session).map(b => b.provider_type).sort()).toEqual([
    "gemini.candidate.content", "gemini.payload.content", "gemini.response.content", "gemini.response.content", "gemini.user.content"]);
});
