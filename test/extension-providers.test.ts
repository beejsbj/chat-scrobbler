import { expect, test } from "bun:test";
import { createChatgptAdapter } from "../packages/extension/src/providers/chatgpt";
import { createClaudeAdapter } from "../packages/extension/src/providers/claude";
import { isRateLimitError, type FetchLike } from "../packages/extension/src/providers";

test("ChatGPT adapter fetches only conversations newer than the cursor", async () => {
  const calls: string[] = [];
  const fetcher: FetchLike = async (input, init) => {
    calls.push(`${input}:${init?.headers ? "auth" : "noauth"}`);
    if (input === "/api/auth/session") return json({ accessToken: "tok" });
    if (String(input).startsWith("/backend-api/conversations")) {
      return json({
        items: [
          { id: "old", update_time: "2026-06-05T09:00:00.000Z" },
          { id: "new", update_time: "2026-06-05T11:00:00.000Z" },
        ],
      });
    }
    if (input === "/backend-api/conversation/new") return json({ id: "new", mapping: {} });
    throw new Error(`unexpected fetch ${input}`);
  };
  const captures: unknown[] = [];

  const result = await createChatgptAdapter(fetcher).sync({
    lastSync: "2026-06-05T10:00:00.000Z",
    emitCapture: async (capture) => { captures.push(capture); },
  });

  expect(result).toMatchObject({ scanned: 2, captured: 1, skipped: 1 });
  expect(captures).toHaveLength(1);
  expect(calls).toContain("/backend-api/conversation/new:auth");
  expect(calls.some((call) => call.startsWith("/backend-api/conversation/old"))).toBe(false);
});

test("ChatGPT adapter skips ignored conversations before detail fetch", async () => {
  const calls: string[] = [];
  const fetcher: FetchLike = async (input) => {
    calls.push(String(input));
    if (input === "/api/auth/session") return json({ accessToken: "tok" });
    if (String(input).startsWith("/backend-api/conversations")) {
      return json({ items: [{ id: "ignored", update_time: "2026-06-05T11:00:00.000Z" }] });
    }
    if (String(input).startsWith("/backend-api/conversation/")) {
      throw new Error(`unexpected detail fetch ${input}`);
    }
    throw new Error(`unexpected fetch ${input}`);
  };

  const result = await createChatgptAdapter(fetcher).sync({
    lastSync: null,
    emitCapture: async () => { throw new Error("should not emit ignored capture"); },
    shouldIgnore: (source, id) => source === "chatgpt" && id === "ignored",
  });

  expect(result).toMatchObject({ scanned: 1, captured: 0, skipped: 1 });
  expect(calls.some((call) => call.startsWith("/backend-api/conversation/ignored"))).toBe(false);
});

test("ChatGPT adapter does not advance cursor from ignored conversations", async () => {
  const fetcher: FetchLike = async (input) => {
    if (input === "/api/auth/session") return json({ accessToken: "tok" });
    if (String(input).startsWith("/backend-api/conversations")) {
      return json({
        items: [
          { id: "ignored-newest", update_time: "2026-06-05T12:00:00.000Z" },
          { id: "captured-older", update_time: "2026-06-05T11:00:00.000Z" },
        ],
      });
    }
    if (input === "/backend-api/conversation/captured-older") return json({ id: "captured-older", mapping: {} });
    throw new Error(`unexpected fetch ${input}`);
  };

  const result = await createChatgptAdapter(fetcher).sync({
    lastSync: null,
    emitCapture: async () => {},
    shouldIgnore: (source, id) => source === "chatgpt" && id === "ignored-newest",
  });

  expect(result).toMatchObject({ scanned: 2, captured: 1, skipped: 1 });
  expect(result.maxConversationUpdatedAt).toBe("2026-06-05T11:00:00.000Z");
});

test("ChatGPT adapter uploads discovered attachment bytes into raw capture assets", async () => {
  const fetcher: FetchLike = async (input) => {
    if (input === "/api/auth/session") return json({ accessToken: "tok" });
    if (String(input).startsWith("/backend-api/conversations")) {
      return json({ items: [{ id: "with-asset", update_time: "2026-06-05T11:00:00.000Z" }] });
    }
    if (input === "/backend-api/conversation/with-asset") {
      return json({
        conversation_id: "with-asset",
        mapping: {
          root: { id: "root", message: null, parent: null, children: ["m1"] },
          m1: {
            id: "m1",
            parent: "root",
            children: [],
            message: {
              id: "m1",
              author: { role: "user" },
              content: {
                content_type: "multimodal_text",
                parts: [{ content_type: "image_asset_pointer", asset_pointer: "file-service://file-1" }],
              },
              metadata: {},
            },
          },
        },
      });
    }
    if (input === "/backend-api/files/file-1/download") {
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
    }
    throw new Error(`unexpected fetch ${input}`);
  };
  const captures: Array<{ assets?: unknown[] }> = [];

  await createChatgptAdapter(fetcher).sync({
    lastSync: null,
    emitCapture: async (capture) => { captures.push(capture); },
    uploadAsset: async (asset) => ({
      pointer: asset.pointer,
      local_path: "assets/chatgpt/with-asset/hash.png",
      filename: asset.filename ?? null,
      content_type: asset.contentType ?? null,
      size_bytes: asset.bytes.length,
      sha256: "hash",
    }),
  });

  expect(captures[0].assets).toEqual([expect.objectContaining({
    pointer: "file-service://file-1",
    local_path: "assets/chatgpt/with-asset/hash.png",
    content_type: "image/png",
  })]);
});

test("ChatGPT adapter stops paginating early when cursor page is all old", async () => {
  const pageRequests: string[] = [];
  const fetcher: FetchLike = async (input) => {
    const url = String(input);
    if (url === "/api/auth/session") return json({ accessToken: "tok" });
    if (url.startsWith("/backend-api/conversations")) {
      pageRequests.push(url);
      const offset = Number(new URL(url, "http://x").searchParams.get("offset") ?? "0");
      if (offset === 0) {
        // page 0: full page (50 items) of NEW conversations
        return json({
          items: Array.from({ length: 50 }, (_, i) => ({
            id: `new-${i}`,
            update_time: "2026-06-05T12:00:00.000Z",
          })),
        });
      }
      if (offset === 50) {
        // page 1: full page of OLD conversations — early-break should trigger here
        return json({
          items: Array.from({ length: 50 }, (_, i) => ({
            id: `old-${i}`,
            update_time: "2026-06-05T08:00:00.000Z",
          })),
        });
      }
      // page 2 should NEVER be requested
      throw new Error(`Unexpected pagination to offset ${offset}`);
    }
    if (url.startsWith("/backend-api/conversation/")) return json({ id: url.split("/").pop() });
    throw new Error(`unexpected fetch ${url}`);
  };
  const captures: unknown[] = [];

  const result = await createChatgptAdapter(fetcher).sync({
    lastSync: "2026-06-05T10:00:00.000Z",
    emitCapture: async (c) => { captures.push(c); },
  });

  // Should have captured the 50 new ones and skipped the 50 old ones
  expect(result.captured).toBe(50);
  expect(result.skipped).toBe(50);
  // Page 2 (offset=100) must not have been requested
  expect(pageRequests.some((u) => u.includes("offset=100"))).toBe(false);
  expect(pageRequests.some((u) => u.includes("offset=50"))).toBe(true);
});

test("ChatGPT adapter without cursor walks all pages (full reconcile)", async () => {
  let pageCount = 0;
  const fetcher: FetchLike = async (input) => {
    const url = String(input);
    if (url === "/api/auth/session") return json({});
    if (url.startsWith("/backend-api/conversations")) {
      pageCount += 1;
      const offset = Number(new URL(url, "http://x").searchParams.get("offset") ?? "0");
      if (offset === 0) {
        return json({
          items: Array.from({ length: 50 }, (_, i) => ({
            id: `c-${i}`,
            update_time: "2026-06-01T00:00:00.000Z",
          })),
        });
      }
      // second page: partial (< limit) — stops pagination normally
      return json({ items: [{ id: "c-last", update_time: "2026-05-01T00:00:00.000Z" }] });
    }
    if (url.startsWith("/backend-api/conversation/")) return json({ id: url.split("/").pop() });
    throw new Error(`unexpected fetch ${url}`);
  };

  await createChatgptAdapter(fetcher).sync({
    lastSync: null, // no cursor → full reconcile
    emitCapture: async () => {},
  });

  // Without a cursor, early-break must NOT fire; both pages should be fetched
  expect(pageCount).toBe(2);
});

test("ChatGPT adapter normalizes numeric string timestamps to ISO", async () => {
  const fetcher: FetchLike = async (input) => {
    if (input === "/api/auth/session") return json({ accessToken: "tok" });
    if (String(input).startsWith("/backend-api/conversations")) {
      return json({ items: [{ id: "epoch", update_time: "1717689600" }] });
    }
    throw new Error(`unexpected fetch ${input}`);
  };

  const rows = await createChatgptAdapter(fetcher).listConversations?.(1);

  expect(rows?.[0]).toEqual({
    id: "epoch",
    updatedAt: new Date(1717689600 * 1000).toISOString(),
  });
});

test("ChatGPT captureOne throws a recognizable rate-limit error", async () => {
  const fetcher: FetchLike = async (input) => {
    if (input === "/api/auth/session") return json({ accessToken: "tok" });
    if (input === "/backend-api/conversation/limited") {
      return new Response("", { status: 429, headers: { "retry-after": "3" } });
    }
    throw new Error(`unexpected fetch ${input}`);
  };

  const error = await createChatgptAdapter(fetcher).captureOne?.("limited", null, async () => {})
    .then(() => null, (caught) => caught);

  expect(isRateLimitError(error)).toBe(true);
  expect(error).toMatchObject({ name: "RateLimitError", retryAfterMs: 3_000, status: 429 });
});

test("Claude adapter discovers org and captures conversation details", async () => {
  let detailUrl = "";
  const fetcher: FetchLike = async (input) => {
    if (input === "/api/organizations") return json([{ uuid: "org-1" }]);
    if (String(input).startsWith("/api/organizations/org-1/chat_conversations?")) {
      return json([{ uuid: "cl-1", updated_at: "2026-06-05T11:00:00.000Z" }]);
    }
    if (String(input).startsWith("/api/organizations/org-1/chat_conversations/cl-1")) {
      detailUrl = String(input);
      return json({ uuid: "cl-1", chat_messages: [] });
    }
    throw new Error(`unexpected fetch ${input}`);
  };
  const captures: Array<{ source_id: string; account?: string | null }> = [];

  const result = await createClaudeAdapter(fetcher).sync({
    lastSync: null,
    emitCapture: async (capture) => { captures.push(capture); },
  });

  expect(result).toMatchObject({ source: "claude", scanned: 1, captured: 1, account: "org-1" });
  expect(captures).toEqual([expect.objectContaining({ source_id: "cl-1", account: "org-1" })]);
  // Detail fetch MUST request the tree rendering, or content blocks are dropped.
  expect(detailUrl).toContain("tree=True");
  expect(detailUrl).toContain("rendering_mode=messages");
});

test("Claude adapter skips ignored conversations before detail fetch", async () => {
  const calls: string[] = [];
  const fetcher: FetchLike = async (input) => {
    calls.push(String(input));
    if (input === "/api/organizations") return json([{ uuid: "org-1" }]);
    if (String(input).startsWith("/api/organizations/org-1/chat_conversations?")) {
      return json([{ uuid: "ignored", updated_at: "2026-06-05T11:00:00.000Z" }]);
    }
    if (String(input).includes("/chat_conversations/ignored")) {
      throw new Error(`unexpected detail fetch ${input}`);
    }
    throw new Error(`unexpected fetch ${input}`);
  };

  const result = await createClaudeAdapter(fetcher).sync({
    lastSync: null,
    emitCapture: async () => { throw new Error("should not emit ignored capture"); },
    shouldIgnore: (source, id) => source === "claude" && id === "ignored",
  });

  expect(result).toMatchObject({ scanned: 1, captured: 0, skipped: 1 });
  expect(calls.some((call) => call.includes("/chat_conversations/ignored"))).toBe(false);
});

test("Claude adapter does not advance cursor from ignored conversations", async () => {
  const fetcher: FetchLike = async (input) => {
    if (input === "/api/organizations") return json([{ uuid: "org-1" }]);
    if (String(input).startsWith("/api/organizations/org-1/chat_conversations?")) {
      return json([
        { uuid: "ignored-newest", updated_at: "2026-06-05T12:00:00.000Z" },
        { uuid: "captured-older", updated_at: "2026-06-05T11:00:00.000Z" },
      ]);
    }
    if (String(input).startsWith("/api/organizations/org-1/chat_conversations/captured-older")) {
      return json({ uuid: "captured-older", chat_messages: [] });
    }
    throw new Error(`unexpected fetch ${input}`);
  };

  const result = await createClaudeAdapter(fetcher).sync({
    lastSync: null,
    emitCapture: async () => {},
    shouldIgnore: (source, id) => source === "claude" && id === "ignored-newest",
  });

  expect(result).toMatchObject({ scanned: 2, captured: 1, skipped: 1 });
  expect(result.maxConversationUpdatedAt).toBe("2026-06-05T11:00:00.000Z");
});

test("Claude adapter uploads discovered file bytes into raw capture assets", async () => {
  const fetcher: FetchLike = async (input) => {
    if (input === "/api/organizations") return json([{ uuid: "org-1" }]);
    if (String(input).startsWith("/api/organizations/org-1/chat_conversations?")) {
      return json([{ uuid: "cl-asset", updated_at: "2026-06-05T11:00:00.000Z" }]);
    }
    if (String(input).startsWith("/api/organizations/org-1/chat_conversations/cl-asset")) {
      return json({
        uuid: "cl-asset",
        chat_messages: [
          { uuid: "m1", sender: "human", files: [{ file_uuid: "file-1", file_name: "paper.pdf", content_type: "application/pdf" }] },
        ],
      });
    }
    if (input === "/api/organizations/org-1/files/file-1/download") {
      return new Response(new Uint8Array([4, 5, 6]), { headers: { "content-type": "application/pdf" } });
    }
    throw new Error(`unexpected fetch ${input}`);
  };
  const captures: Array<{ assets?: unknown[] }> = [];

  await createClaudeAdapter(fetcher).sync({
    lastSync: null,
    emitCapture: async (capture) => { captures.push(capture); },
    uploadAsset: async (asset) => ({
      pointer: asset.pointer,
      local_path: "assets/claude/cl-asset/hash.pdf",
      filename: asset.filename ?? null,
      content_type: asset.contentType ?? null,
      size_bytes: asset.bytes.length,
      sha256: "hash",
    }),
  });

  expect(captures[0].assets).toEqual([expect.objectContaining({
    pointer: "file-1",
    filename: "paper.pdf",
    local_path: "assets/claude/cl-asset/hash.pdf",
    content_type: "application/pdf",
  })]);
});

test("Claude adapter normalizes numeric string timestamps to ISO", async () => {
  const fetcher: FetchLike = async (input) => {
    if (input === "/api/organizations") return json([{ uuid: "org-1" }]);
    if (String(input).startsWith("/api/organizations/org-1/chat_conversations?")) {
      return json([{ uuid: "epoch", updated_at: "1717689600" }]);
    }
    throw new Error(`unexpected fetch ${input}`);
  };

  const rows = await createClaudeAdapter(fetcher).listConversations?.(1);

  expect(rows?.[0]).toEqual({
    id: "epoch",
    updatedAt: new Date(1717689600 * 1000).toISOString(),
  });
});

test("Claude captureOne throws a recognizable rate-limit error", async () => {
  const fetcher: FetchLike = async (input) => {
    if (input === "/api/organizations") return json([{ uuid: "org-1" }]);
    if (String(input).startsWith("/api/organizations/org-1/chat_conversations/limited")) {
      return new Response("", { status: 503, headers: { "retry-after": "4" } });
    }
    throw new Error(`unexpected fetch ${input}`);
  };

  const error = await createClaudeAdapter(fetcher).captureOne?.("limited", null, async () => {})
    .then(() => null, (caught) => caught);

  expect(isRateLimitError(error)).toBe(true);
  expect(error).toMatchObject({ name: "RateLimitError", retryAfterMs: 4_000, status: 503 });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
