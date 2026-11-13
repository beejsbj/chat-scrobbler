// Synthetic shapes for the positional Gemini slots the monitor kept reporting after the first sweep.
// Values are invented; only the array layout follows what the web client sends. A layout that does
// not match must fall back to an unknown block and never cost the message text.
import { test, expect } from "bun:test";
import { parseGemini } from "../src/parsers/gemini";
import sample from "./fixtures/gemini-api-sample.json";

const USER_ID = "r_0336cee8638641d7";

function parseWith(mutate: (turn: any[], capture: any) => void) {
  const capture = structuredClone(sample) as any;
  mutate(capture.payload[0][0], capture);
  const [session] = parseGemini(capture, { raw_ref: "gemini/id/v1.json.gz" });
  return session;
}
const assistant = (session: { messages: any[] }) => session.messages.find(m => m.role === "assistant");
const unknowns = (session: { messages: Array<{ blocks: any[] }> }) =>
  session.messages.flatMap(m => m.blocks).filter(b => b.type === "unknown").map(b => b.provider_type);
const candidate = (turn: any[]) => turn[3][0][0];
const ANSWER = candidate(structuredClone((sample as any).payload[0][0]))[1][0];

const thinking = (sections: Array<[string, string]>) => {
  const md = sections.map(([title, body]) => `**${title}**\n\n${body}`);
  return [[md.join("\n\n")], sections.map(([title, body], i) =>
    [[md[i]], "", "", "", [[[null, [null, 1, title, [[0, 3, [[null, null, null, null, 1]]]]]], [null, [null, 1, body]]]], title, body])];
};

test("thinking summaries become one reasoning block ahead of the answer, never twice", () => {
  const session = parseWith(turn => { candidate(turn)[37] = thinking([["Plan", "Compare the options."], ["Check", "Verify the sums."]]); });
  const message = assistant(session);
  expect(unknowns(session)).toEqual([]);
  expect(message.blocks.map((b: any) => b.type)).toEqual(["reasoning", "text"]);
  expect(message.blocks[0]).toEqual({ type: "reasoning", text: "**Plan**\n\nCompare the options.\n\n**Check**\n\nVerify the sums.", summary: true });
  expect(message.text.split("Compare the options.").length).toBe(2);
  expect(message.text).toContain(ANSWER.slice(0, 20));
});

test("a thinking layout that drifts alerts and keeps the answer text", () => {
  const drift = (value: unknown) => {
    const session = parseWith(turn => { candidate(turn)[37] = value; });
    expect(unknowns(session)).toEqual(["gemini.candidate.content"]);
    expect(assistant(session).text).toContain(ANSWER.slice(0, 20));
  };
  drift([["whole"], "not a list"]);
  drift([[""], thinking([["A", "b"]])[1]]);
  drift([[42], []]);
  const [whole, sections] = thinking([["A", "alpha"], ["B", "beta"]]);
  drift([whole, [...sections, [["a section the whole text lacks"], "", "", "", [], "C", "d"]]]);
  drift([whole, [sections[0], "junk"]]);
  drift([whole]);
});

test("grounding citations in slot 2 become deduplicated citation blocks without the quoted answer text", () => {
  const source = (url: string, title: string, snippet: string | null) => [url, title, "https://favicon.example.org/f.png", snippet, [["quoted", null, null, [[0, 6]]]], null, "web", 0, ""];
  const entry = (sources: unknown[]) => [["quoted answer span", null, null, [[0, 5], [6, 9]]], [1], sources, "label"];
  const session = parseWith(turn => { candidate(turn)[2] = [null, [
    entry([source("https://example.org/a", "Page A", "A snippet")]),
    entry([source("https://example.org/a", "Page A", "A snippet"), source("https://example.org/b", "Page B", null)])]]; });
  const message = assistant(session);
  expect(unknowns(session)).toEqual([]);
  expect(message.blocks.filter((b: any) => b.type === "citation")).toEqual([
    { type: "citation", provider_type: "gemini.grounding", url: "https://example.org/a", title: "Page A", text: "A snippet" },
    { type: "citation", provider_type: "gemini.grounding", url: "https://example.org/b", title: "Page B", text: null }]);
  expect(message.text).not.toContain("quoted answer span");
  expect(message.text).not.toContain("favicon");
});

test("grounding layouts that drift alert, and the message text survives", () => {
  for (const value of [
    [null, [[["q", null, null, []], [1], [["not a url", "Title", "icon", "snippet"]], "x"]]],
    [null, [[["q"], [1], "sources", "x"]]],
    [null, "nope"],
    [null, [[["q"], [1], [], "x"]]],
    [1, [[["q"], [1], [["https://example.org/a", "T"]], "x"]]],
  ]) {
    const session = parseWith(turn => { candidate(turn)[2] = value; });
    expect(unknowns(session)).toEqual(["gemini.candidate.content"]);
    expect(assistant(session).text).toContain(ANSWER.slice(0, 20));
  }
});

const card = (video: unknown[], label = "youtube") => [["card-1", null, null, null, null,
  [null, null, null, null, [[["https://placeholder.example.org/p", null, null, null, null, null, ["YouTube", "https://icon.example.org/i.png", null, label]],
    null, null, null, [[video]]]]], null, [[1, 2], null, 3, false, false], [], "x", 1, null, false]];

test("YouTube cards in slot 30 become citations carrying title, link and channel", () => {
  const video = (title: string, id: string, channel: string | null) => [title, id, `https://video.example.org/watch?v=${id}`, channel, null, null, null, 1, 2, "x", "y", ["card-1"], "https://thumb.example.org/t.jpg"];
  const session = parseWith(turn => { candidate(turn)[30] = [...card(video("Intro talk", "abcDEF12345", "Some Channel")), ...card(video("Second", "ghiJKL67890", null))]; });
  expect(unknowns(session)).toEqual([]);
  expect(assistant(session).blocks.filter((b: any) => b.type === "citation")).toEqual([
    { type: "citation", provider_type: "gemini.youtube", url: "https://video.example.org/watch?v=abcDEF12345", title: "Intro talk", text: "Some Channel" },
    { type: "citation", provider_type: "gemini.youtube", url: "https://video.example.org/watch?v=ghiJKL67890", title: "Second", text: null }]);
});

test("cards of another kind, or with a changed layout, alert", () => {
  const good = ["Title", "abcDEF12345", "https://video.example.org/w", "Chan"];
  for (const value of [card(good, "maps"), card(["Title", 7, "https://video.example.org/w", "Chan"]), card(["Title", "id", "not a url", "Chan"]), [["card-1"]], "nope"]) {
    const session = parseWith(turn => { candidate(turn)[30] = value; });
    expect(unknowns(session)).toEqual(["gemini.candidate.content"]);
    expect(assistant(session).text).toContain(ANSWER.slice(0, 20));
  }
});

const fileCite = (name: string, quote: string, n = 1) => [[`[cite: ${n}]`, 0], [[null, [[null, 11, name, null, [1, null, "status"], null, null, null, 1, null, null, "x"], null, null, null, null, null, name]]], [quote, 0]];

test("file citations in slot 12 become citations of the uploaded file, empty keys are noise", () => {
  const session = parseWith(turn => { candidate(turn)[12] = [{ "8": [], "19": 1, "44": [fileCite("report.pdf", "Revenue grew."), fileCite("report.pdf", "Revenue grew.", 2), fileCite("notes.txt", "Second quote.", 3)], "53": [1] }]; });
  expect(unknowns(session)).toEqual([]);
  expect(assistant(session).blocks.filter((b: any) => b.type === "citation")).toEqual([
    { type: "citation", provider_type: "gemini.file_citation", url: null, title: "report.pdf", text: "Revenue grew." },
    { type: "citation", provider_type: "gemini.file_citation", url: null, title: "notes.txt", text: "Second quote." }]);
  expect(assistant(session).text).toContain(ANSWER.slice(0, 20));
});

test("slot 12 with all-empty keys is noise, with an unrecognised key it keeps the citations and alerts", () => {
  const empty = parseWith(turn => { candidate(turn)[12] = [{ "8": [] }]; });
  expect(unknowns(empty)).toEqual([]);
  const mixed = parseWith(turn => { candidate(turn)[12] = [{ "44": [fileCite("report.pdf", "Quote.")], "89": [[["something new"]]] }]; });
  expect(unknowns(mixed)).toEqual(["gemini.candidate.content"]);
  expect(assistant(mixed).blocks.filter((b: any) => b.type === "citation")).toHaveLength(1);
  for (const value of [[{ "44": [[["[cite: 1]", 0], "x", ["q", 0]]] }], [{ "44": "nope" }], [null, { "44": [[["[cite: 1]", 0], fileCite("a.pdf", "q")[1], [5, 0]]] }], [{ "44": [] }, "x"]]) {
    const session = parseWith(turn => { candidate(turn)[12] = value; });
    expect(unknowns(session)).toEqual(["gemini.candidate.content"]);
    expect(assistant(session).text).toContain(ANSWER.slice(0, 20));
  }
});

const toolRow = (key: string, name: string, status: string) => [null, [key, [null, null, name, "https://icon.example.org/s.png", null, status], 2]];

test("model name and tool activity labels are known metadata; a changed layout alerts", () => {
  const session = parseWith(turn => {
    turn[3][31] = "model-id-1.5";
    turn[3][4] = [toolRow("search", "Web search", "Searching"), toolRow("search", "Web search", "Searching")];
    turn[3][5] = [toolRow("search", "Web search", "Searching"), [null, ["code", [null, null, "", ""], 2, [null, [], false]]]];
  });
  expect(unknowns(session)).toEqual([]);
  expect(assistant(session).blocks.map((b: any) => b.type)).toEqual(["text"]);
  const drift = parseWith(turn => {
    turn[3][31] = "a free text sentence that is clearly not a model name, it goes on";
    turn[3][4] = [[null, ["search", "no label object", 2]]];
    turn[3][5] = [toolRow("search", "Web search", "Searching"), "stray"];
  });
  expect(unknowns(drift)).toEqual(["gemini.response.content", "gemini.response.content", "gemini.response.content"]);
});

const descriptor = (name: string, token: string, urls: string[] = [`https://lh3.googleusercontent.com/${name}-preview`, `https://lh3.googleusercontent.com/${name}-download`]) =>
  [null, 11, name, null, null, token, null, [urls[0], urls[1], urls[0]], 1, [2, 3], null, "x"];

test("uploaded files name themselves without storing the token, in both nesting layouts", () => {
  const session = parseWith(turn => {
    turn[2][0][4] = [[null, null, null, null, [descriptor("report.pdf", "tok-aaa"), descriptor("clip.mp4", "tok-bbb")]]];
  });
  const message = session.messages[0];
  expect(unknowns(session)).toEqual([]);
  expect(message.blocks.slice(1).map((b: any) => [b.type, b.filename, b.local_path])).toEqual([["file", "report.pdf", null], ["video", "clip.mp4", null]]);
  expect(message.text).toContain("[file: report.pdf]");
  expect(message.text).toContain("[video: clip.mp4]");
  expect(JSON.stringify(message)).not.toContain("tok-aaa");
  expect(message.text).not.toContain("googleusercontent");
  const nested = parseWith(turn => {
    turn[2][0][4] = [[null, null, null, [descriptor("a.pdf", "tok-1")], [descriptor("a.pdf", "tok-1"), descriptor("b.pdf", "tok-2")]]];
  });
  expect(nested.messages[0].blocks.slice(1).map((b: any) => b.filename)).toEqual(["a.pdf", "b.pdf"]);
});

test("an uploaded file that was captured links to the asset once, under its real name", () => {
  const session = parseWith((turn, capture) => {
    turn[2][0][4] = [[null, null, null, null, [descriptor("report.pdf", "tok-aaa")]]];
    capture.assets = [{ pointer: "https://lh3.googleusercontent.com/report.pdf-download", local_path: "assets/gemini/id/abc.pdf", message_id: USER_ID,
      filename: null, content_type: "application/pdf", sha256: "a".repeat(64) }];
  });
  const media = session.messages[0].blocks.filter((b: any) => b.type !== "text");
  expect(media).toHaveLength(1);
  expect(media[0]).toMatchObject({ type: "file", filename: "report.pdf", local_path: "assets/gemini/id/abc.pdf", pointer: "https://lh3.googleusercontent.com/report.pdf-download" });
  expect(session.messages[0].text).toContain("[file: report.pdf -> assets/gemini/id/abc.pdf]");
});

test("an upload whose url was recorded but not captured stays one block, named, under the recorded pointer", () => {
  const session = parseWith((turn, capture) => {
    turn[2][0][4] = [[null, null, null, null, [descriptor("big.mp4", "tok-vid")]]];
    capture.asset_references = [{ pointer: "https://lh3.googleusercontent.com/big.mp4-preview", message_id: USER_ID, filename: null, content_type: null }];
  });
  const media = session.messages[0].blocks.filter((b: any) => b.type !== "text");
  expect(media).toHaveLength(1);
  expect(media[0]).toMatchObject({ type: "video", filename: "big.mp4", local_path: null, pointer: "https://lh3.googleusercontent.com/big.mp4-preview" });
});

test("upload slots that do not match keep alerting, and the user text survives", () => {
  const deep = [[[[[[[[descriptor("x.pdf", "tok")]]]]]]]];
  for (const value of [
    [[null, null, null, null, [[null, 11, "x.pdf"]]]],                         // no token
    [[null, null, null, null, [descriptor("x.pdf", "tok"), "stray string"]]],  // a leaf that is not a descriptor
    [[null, null, null, null, [[null, "11", "x.pdf", null, null, "tok"]]]],    // type code changed shape
    [[null, null, null, null, [[null, 11, "x.pdf", null, null, "tok", null, null, ["https://lh3.googleusercontent.com/u"]]]]], // url list moved
    deep,                                                                       // nested past the depth cap
  ]) {
    const session = parseWith(turn => { turn[2][0][4] = value; });
    expect(unknowns(session)).toEqual(["gemini.part"]);
    expect(session.messages[0].text).toBe("Elliott Beewick");
  }
});

test("slots too rare to read stay unknown", () => {
  const session = parseWith((turn, capture) => {
    turn[2][0][6] = [[null, [], null, "id-1", ["id-1", "kind", [["https://x.example.org", 1]], null, null, null, null, ["text"]]]];
    capture.payload[3] = [[[[[[null, null, null, [null, 1, "Title", "https://x.example.org"]], ["https://x.example.org"], null, [1, "body"], null, null, null, null, "tag"]], null, [true]]]];
  });
  expect(unknowns(session).sort()).toEqual(["gemini.part", "gemini.payload.content"]);
});
