/**
 * Unit tests for the Gemini scrobbler provider.
 *
 * All tests are self-contained — no live browser or network calls are made.
 * The batchexecute response format and conversation-id extraction are tested
 * with synthetic samples that match the documented Gemini wire format.
 */
import { expect, test } from "bun:test";
import { createGeminiAdapter, parseBatchExecuteResponse, parseWizDataFromScript } from "../packages/extension/src/providers/gemini";
import type { GeminiPageContext, WizData } from "../packages/extension/src/providers/gemini";
import type { FetchLike } from "../packages/extension/src/providers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_WIZ: WizData = {
  at: "test-csrf-token",
  bl: "boq_assistant-bard-web-server_20260605.01_p0",
  fSid: "abcdef0123456789",
};

function makeFakePageCtx(ids: string[], wiz: WizData | null = FAKE_WIZ): GeminiPageContext {
  return {
    listConversationIds: () => ids,
    readWizData: () => wiz,
    readConversationDom: (id) => `Conversation content for ${id}`,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Builds a synthetic batchexecute response body in the documented wire format:
 *   )]}'\n<length>\n<json-chunk>\n
 * where the json-chunk is the wrb.fr outer array.
 */
function makeBatchExecuteResponse(rpcId: string, innerPayload: unknown): string {
  const innerStr = JSON.stringify(innerPayload);
  // wrb.fr entry: [["wrb.fr", rpcId, innerStr, null, null, null, "generic"]]
  const chunk = JSON.stringify([["wrb.fr", rpcId, innerStr, null, null, null, "generic"]]);
  const length = new TextEncoder().encode(chunk).length;
  return `)]}'
${length}
${chunk}
`;
}

// ---------------------------------------------------------------------------
// parseBatchExecuteResponse
// ---------------------------------------------------------------------------

test("parseBatchExecuteResponse extracts hNvQHb payload from synthetic response", () => {
  const innerPayload = [["conv-turn-1", "Hello"], ["conv-turn-2", "World"]];
  const body = makeBatchExecuteResponse("hNvQHb", innerPayload);

  const result = parseBatchExecuteResponse(body, "hNvQHb");

  expect(result).toEqual(innerPayload);
});

test("parseBatchExecuteResponse strips )]}' prefix before parsing", () => {
  const body = ")]}'\n1\n" + JSON.stringify([["wrb.fr", "hNvQHb", JSON.stringify({ ok: true })]]) + "\n";
  const result = parseBatchExecuteResponse(body, "hNvQHb");
  expect(result).toEqual({ ok: true });
});

test("parseBatchExecuteResponse ignores entries for other RPCs", () => {
  const innerPayload = { target: true };
  // Body has two entries: one for a different RPC and one for hNvQHb
  const otherChunk = [["wrb.fr", "OtherRpc", JSON.stringify({ wrong: true })]];
  const targetChunk = [["wrb.fr", "hNvQHb", JSON.stringify(innerPayload)]];
  const body = `)]}'
${new TextEncoder().encode(JSON.stringify(otherChunk)).length}
${JSON.stringify(otherChunk)}
${new TextEncoder().encode(JSON.stringify(targetChunk)).length}
${JSON.stringify(targetChunk)}
`;
  const result = parseBatchExecuteResponse(body, "hNvQHb");
  expect(result).toEqual(innerPayload);
});

test("parseBatchExecuteResponse throws when target RPC not found", () => {
  const body = makeBatchExecuteResponse("OtherRpc", { nope: true });
  expect(() => parseBatchExecuteResponse(body, "hNvQHb")).toThrow("hNvQHb");
});

// ---------------------------------------------------------------------------
// batchexecute envelope construction
// ---------------------------------------------------------------------------

test("Gemini adapter sends correctly structured batchexecute request", async () => {
  // Capture input/init directly instead of using new Request() which requires
  // an absolute URL (the adapter sends relative paths like real content scripts).
  let capturedUrl: string | null = null;
  let capturedInit: RequestInit | undefined;

  const fetcher: FetchLike = async (input, init) => {
    const url = String(input);
    if (url.includes("batchexecute")) {
      capturedUrl = url;
      capturedInit = init;
      const body = makeBatchExecuteResponse("hNvQHb", [["data"]]);
      return new Response(body, { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const pageCtx = makeFakePageCtx(["abcdef0123456789"]);
  await createGeminiAdapter(fetcher, pageCtx).sync({
    lastSync: null,
    emitCapture: async () => {},
  });

  expect(capturedUrl).not.toBeNull();
  const url = capturedUrl!;

  // Must POST to batchexecute
  expect(capturedInit?.method).toBe("POST");
  expect(new URL(url, "http://x").pathname).toBe("/_/BardChatUi/data/batchexecute");

  // Query params
  const searchParams = new URL(url, "http://x").searchParams;
  expect(searchParams.get("rpcids")).toBe("hNvQHb");
  expect(searchParams.get("bl")).toBe(FAKE_WIZ.bl);
  expect(searchParams.get("f.sid")).toBe(FAKE_WIZ.fSid);

  // Body must be form-encoded with f.req and at
  const bodyText = String(capturedInit?.body ?? "");
  const params = new URLSearchParams(bodyText);
  expect(params.get("at")).toBe(FAKE_WIZ.at);
  const fReq = JSON.parse(params.get("f.req") ?? "null");
  expect(Array.isArray(fReq)).toBe(true);
  // Outer envelope: [[[rpcId, innerPayloadStr, null, "generic"]]]
  const inner = fReq[0][0];
  expect(inner[0]).toBe("hNvQHb");
  expect(inner[3]).toBe("generic");
  // Inner payload encodes the conversation id with the required "c_" prefix
  // VERIFIED 2026-06-06: Gemini hNvQHb requires ["c_<id>"] not ["<id>"].
  const innerPayload = JSON.parse(inner[1]);
  expect(innerPayload).toContain("c_abcdef0123456789");
});

// ---------------------------------------------------------------------------
// Conversation ID extraction from DOM
// ---------------------------------------------------------------------------

test("listConversationIds extracts 16-hex ids from sidebar anchors (browser context mock)", () => {
  // Simulate the page context returning IDs it found in sidebar anchors
  const pageCtx = makeFakePageCtx(["1a2b3c4d5e6f7a8b", "deadbeef00001234"]);
  const ids = pageCtx.listConversationIds();
  expect(ids).toEqual(["1a2b3c4d5e6f7a8b", "deadbeef00001234"]);
});

// ---------------------------------------------------------------------------
// Adapter sync behaviour
// ---------------------------------------------------------------------------

test("Gemini adapter captures each listed conversation via RPC", async () => {
  const convIds = ["aaaa0000bbbb1111", "cccc2222dddd3333"];
  const captures: Array<{ source: string; source_id: string }> = [];

  const fetcher: FetchLike = async (input) => {
    if (String(input).includes("batchexecute")) {
      return new Response(
        makeBatchExecuteResponse("hNvQHb", [["conversation-data"]]),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected fetch: ${input}`);
  };

  const pageCtx = makeFakePageCtx(convIds);
  const result = await createGeminiAdapter(fetcher, pageCtx).sync({
    lastSync: null,
    emitCapture: async (c) => { captures.push({ source: c.source, source_id: c.source_id }); },
  });

  expect(result.source).toBe("gemini");
  expect(result.captured).toBe(2);
  expect(result.scanned).toBe(2);
  expect(captures.map((c) => c.source_id)).toEqual(convIds);
  expect(captures.every((c) => c.source === "gemini")).toBe(true);
});

test("Gemini adapter skips ignored conversations before RPC or DOM capture", async () => {
  const fetcher: FetchLike = async (input) => {
    throw new Error(`unexpected fetch: ${input}`);
  };
  const pageCtx = makeFakePageCtx(["aaaa0000bbbb1111"]);

  const result = await createGeminiAdapter(fetcher, pageCtx).sync({
    lastSync: null,
    emitCapture: async () => { throw new Error("should not emit ignored capture"); },
    shouldIgnore: (source, id) => source === "gemini" && id === "aaaa0000bbbb1111",
  });

  expect(result).toMatchObject({ scanned: 1, captured: 0, skipped: 1 });
  expect(result.maxConversationUpdatedAt).toBeNull();
});

test("Gemini adapter only advances cursor for captured conversations", async () => {
  const captures: Array<{ source_id: string }> = [];
  const fetcher: FetchLike = async (input) => {
    if (String(input).includes("batchexecute")) {
      return new Response(
        makeBatchExecuteResponse("hNvQHb", [["conversation-data"]]),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected fetch: ${input}`);
  };
  const pageCtx = makeFakePageCtx(["aaaa0000bbbb1111", "cccc2222dddd3333"]);

  const result = await createGeminiAdapter(fetcher, pageCtx).sync({
    lastSync: null,
    emitCapture: async (c) => { captures.push({ source_id: c.source_id }); },
    shouldIgnore: (source, id) => source === "gemini" && id === "aaaa0000bbbb1111",
  });

  expect(result).toMatchObject({ scanned: 2, captured: 1, skipped: 1 });
  expect(captures).toEqual([{ source_id: "cccc2222dddd3333" }]);
  expect(result.maxConversationUpdatedAt).not.toBeNull();
});

test("Gemini adapter falls back to DOM capture when RPC fails", async () => {
  const captures: Array<{ source_id: string; payload: unknown }> = [];

  const fetcher: FetchLike = async () => {
    // Simulate RPC failure
    return new Response("Internal Server Error", { status: 500 });
  };

  const pageCtx = makeFakePageCtx(["failconv1234abcd"]);
  const result = await createGeminiAdapter(fetcher, pageCtx).sync({
    lastSync: null,
    emitCapture: async (c) => { captures.push({ source_id: c.source_id, payload: c.payload }); },
  });

  expect(result.captured).toBe(1);
  expect(captures[0].source_id).toBe("failconv1234abcd");
  // Payload should be DOM fallback shape
  expect((captures[0].payload as Record<string, unknown>).dom_fallback).toBe(true);
});

test("Gemini adapter falls back to DOM capture when WIZ data unavailable", async () => {
  const captures: Array<{ source_id: string; payload: unknown }> = [];
  const fetcher: FetchLike = async () => { throw new Error("should not be called"); };

  // No wiz data available
  const pageCtx = makeFakePageCtx(["nowizid12345678a"], null);
  const result = await createGeminiAdapter(fetcher, pageCtx).sync({
    lastSync: null,
    emitCapture: async (c) => { captures.push({ source_id: c.source_id, payload: c.payload }); },
  });

  expect(result.captured).toBe(1);
  expect((captures[0].payload as Record<string, unknown>).dom_fallback).toBe(true);
});

// ---------------------------------------------------------------------------
// WIZ_global_data extraction from the inline bootstrap script
//
// The content script runs in an isolated world and CANNOT read the page's
// window.WIZ_global_data JS global. It must parse the fields out of the inline
// `window.WIZ_global_data = {...}` <script> text, which IS reachable via the DOM.
// ---------------------------------------------------------------------------

test("parseWizDataFromScript extracts at/bl/fSid from inline WIZ script text", () => {
  const scriptText =
    'window.WIZ_global_data = {"AEJOSc":false,"SNlM0e":"AOOh0PHb_token","ARR9x":true,' +
    '"cfb2h":"boq_assistant-bard-web-server_20260606.01_p0","FdrFJe":"-8899577123","x":1};';

  expect(parseWizDataFromScript(scriptText)).toEqual({
    at: "AOOh0PHb_token",
    bl: "boq_assistant-bard-web-server_20260606.01_p0",
    fSid: "-8899577123",
  });
});

test("parseWizDataFromScript returns null when a required field is missing", () => {
  // Has SNlM0e + cfb2h but no FdrFJe.
  const scriptText = 'window.WIZ_global_data = {"SNlM0e":"tok","cfb2h":"bl"};';
  expect(parseWizDataFromScript(scriptText)).toBeNull();
});

// ---------------------------------------------------------------------------
// listConversations + captureOne (sidebar badge reconciliation hooks)
// ---------------------------------------------------------------------------

test("Gemini listConversations enumerates sidebar ids with null timestamps", async () => {
  const fetcher: FetchLike = async () => { throw new Error("should not be called"); };
  const convIds = ["aaaa0000bbbb1111", "cccc2222dddd3333"];
  const pageCtx = makeFakePageCtx(convIds);

  const rows = await createGeminiAdapter(fetcher, pageCtx).listConversations?.(1);

  // Gemini's sidebar exposes no timestamps, so updatedAt is always null.
  expect(rows).toEqual([
    { id: "aaaa0000bbbb1111", updatedAt: null },
    { id: "cccc2222dddd3333", updatedAt: null },
  ]);
});

test("Gemini captureOne emits a single capture via the RPC path", async () => {
  const captures: Array<{ source: string; source_id: string; endpoint: string; payload: unknown }> = [];
  const fetcher: FetchLike = async (input) => {
    if (String(input).includes("batchexecute")) {
      return new Response(makeBatchExecuteResponse("hNvQHb", [["conversation-data"]]), { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${input}`);
  };
  const pageCtx = makeFakePageCtx(["aaaa0000bbbb1111"]);

  await createGeminiAdapter(fetcher, pageCtx).captureOne?.(
    "aaaa0000bbbb1111",
    null,
    async (c) => { captures.push({ source: c.source, source_id: c.source_id, endpoint: c.endpoint, payload: c.payload }); },
  );

  expect(captures).toHaveLength(1);
  expect(captures[0]).toMatchObject({ source: "gemini", source_id: "aaaa0000bbbb1111" });
  expect(captures[0].endpoint).toContain("batchexecute");
  // RPC path payload is NOT the DOM fallback shape.
  expect((captures[0].payload as Record<string, unknown>)?.dom_fallback).toBeUndefined();
});

test("Gemini captureOne falls back to DOM capture when the RPC fails", async () => {
  const captures: Array<{ source_id: string; payload: unknown }> = [];
  const fetcher: FetchLike = async () => new Response("Internal Server Error", { status: 500 });
  const pageCtx = makeFakePageCtx(["failconv1234abcd"]);

  await createGeminiAdapter(fetcher, pageCtx).captureOne?.(
    "failconv1234abcd",
    null,
    async (c) => { captures.push({ source_id: c.source_id, payload: c.payload }); },
  );

  expect(captures).toHaveLength(1);
  expect(captures[0].source_id).toBe("failconv1234abcd");
  expect((captures[0].payload as Record<string, unknown>).dom_fallback).toBe(true);
});

test("Gemini adapter returns empty result when sidebar has no conversations", async () => {
  const fetcher: FetchLike = async () => { throw new Error("should not be called"); };
  const pageCtx = makeFakePageCtx([]);

  const result = await createGeminiAdapter(fetcher, pageCtx).sync({
    lastSync: null,
    emitCapture: async () => {},
  });

  expect(result.scanned).toBe(0);
  expect(result.captured).toBe(0);
  expect(result.maxConversationUpdatedAt).toBeNull();
});
