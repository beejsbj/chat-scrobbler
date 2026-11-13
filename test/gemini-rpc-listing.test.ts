import { beforeEach, expect, test } from "bun:test";
import { createGeminiAdapter, type GeminiPageContext } from "../packages/extension/src/providers/gemini";
import { collectConversationIds } from "../packages/extension/src/providers/gemini-list-ids";
import { geminiListingTimings, type ListingDiagnostic } from "../packages/extension/src/providers/gemini-sidebar";
import { ProviderListingEmptyError } from "../packages/extension/src/providers/sync-errors";
import { isRateLimitError } from "../packages/extension/src/providers/types";

beforeEach(() => { geminiListingTimings.timeoutMs = 60; geminiListingTimings.pollMs = 1; geminiListingTimings.settleMs = 5; geminiListingTimings.hiddenTimeoutMs = 10; });

const A = "1a2b3c4d5e6f7a8b";
const B = "2b3c4d5e6f7a8b9c";
const C = "3c4d5e6f7a8b9c0d";
const domEmpty: ListingDiagnostic = { ids: 0, appAnchors: 0, anchors: 15, containers: 1, hidden: true, readyState: "complete", waitedMs: 10, timedOut: true };

const wrap = (rpcId: string, inner: unknown) => ")]}'\n\n" + JSON.stringify([["wrb.fr", rpcId, typeof inner === "string" ? inner : JSON.stringify(inner), null, null, null, "generic"]]);
const entry = (id: string, title: string) => [`c_${id}`, title, null, [1700000000, 0]];

interface Call { rpcId: string; inner: string; url: string; body: URLSearchParams }
function fetcher(handlers: { recent?: () => Response | Promise<Response>; pinned?: () => Response | Promise<Response> } = {}) {
  const calls: Call[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    const body = new URLSearchParams(String(init?.body ?? ""));
    const outer = JSON.parse(body.get("f.req")!)[0][0] as [string, string];
    calls.push({ rpcId: outer[0], inner: outer[1], url, body });
    if (outer[0] === "hNvQHb") return new Response(wrap("hNvQHb", [["c"]]));
    if (outer[1] === JSON.stringify([13, null, [0, null, 1]])) return (handlers.recent ?? (() => new Response(wrap("MaZiqc", [[entry(A, "Synthetic one"), entry(B, "Synthetic two")]]))))();
    return (handlers.pinned ?? (() => new Response(wrap("MaZiqc", [[entry(C, "Synthetic pinned")]]))))();
  };
  return { fn, calls, list: () => calls.filter((c) => c.rpcId === "MaZiqc"), detail: () => calls.filter((c) => c.rpcId === "hNvQHb") };
}

function page(opts: { ids?: string[]; wiz?: boolean } = {}): GeminiPageContext {
  return { listConversationIds: () => opts.ids ?? [], awaitConversationIds: async () => ({ ids: opts.ids ?? [], diagnostic: { ...domEmpty, ids: opts.ids?.length ?? 0 } }),
    readWizData: () => opts.wiz === false ? null : { at: "csrf", bl: "build", fSid: "sid" }, readConversationDom: () => null };
}
const run = (f: ReturnType<typeof fetcher>, ctx: GeminiPageContext, options: Record<string, unknown> = {}) =>
  createGeminiAdapter(f.fn, ctx).sync({ emitCapture: async () => true, lastSync: "2026-10-20T00:00:00Z", ...options });

test("the id walker takes c_<16 hex> strings from anywhere, in order, without duplicates", () => {
  const payload = [[["x", [`c_${B}`, "Title"]], `c_${A}`], [{ nested: [`c_${B}`] }], `c_${C}`];
  expect(collectConversationIds(payload)).toEqual([B, A, C]);
});

test("the id walker ignores look-alikes and survives odd input", () => {
  const bad = [`c_${A}0`, `c_${A.slice(1)}`, `c_${A.toUpperCase()}`, A, `r_${A}`, ` c_${A}`, 7, null, true, {}, [], `c_${A}\n`];
  expect(collectConversationIds(bad)).toEqual([]);
  for (const value of [null, undefined, "c_x", 3, {}, []]) expect(collectConversationIds(value)).toEqual([]);
  let deep: unknown = `c_${A}`;
  for (let i = 0; i < 5000; i++) deep = [deep];
  expect(() => collectConversationIds(deep)).not.toThrow();
});

test("an empty sidebar lists through MaZiqc, strips the c_ prefix and captures each conversation", async () => {
  const f = fetcher();
  const result = await run(f, page());
  expect(result).toMatchObject({ scanned: 3, captured: 3, listing: { source: "rpc", ids: 3, hidden: true } });
  expect(f.detail().map((c) => c.inner)).toEqual([A, B, C].map((id) => JSON.stringify([`c_${id}`])));
  const [recent, pinned] = f.list();
  expect(recent!.inner).toBe(JSON.stringify([13, null, [0, null, 1]]));
  expect(pinned!.inner).toBe(JSON.stringify([13, null, [1, null, 1]]));
  expect(recent!.url).toContain("rpcids=MaZiqc");
  expect(new URL(recent!.url, "https://gemini.google.com").searchParams.get("source-path")).toBe("/app");
  expect(recent!.body.get("at")).toBe("csrf");
  expect(recent!.url).toContain("bl=build");
  expect(recent!.url).toContain("f.sid=sid");
});

test("the RPC listing is the same without lastSync on a fresh install and carries no content", async () => {
  const result = await run(fetcher(), page(), { lastSync: null });
  expect(result).toMatchObject({ scanned: 3, listing: { source: "rpc" } });
  const text = JSON.stringify((result as { listing: unknown }).listing);
  for (const secret of [A, B, C, "Synthetic"]) expect(text).not.toContain(secret);
});

test("DOM ids come first: the RPC is not called and the diagnostic says dom", async () => {
  const f = fetcher();
  const result = await run(f, page({ ids: [A] }));
  expect(f.list()).toHaveLength(0);
  expect(result).toMatchObject({ scanned: 1, listing: { source: "dom" } });
});

test("a pinned list that fails keeps the recent ids, and one that repeats them adds nothing twice", async () => {
  const failing = fetcher({ pinned: () => new Response("no", { status: 500 }) });
  expect(await run(failing, page())).toMatchObject({ scanned: 2, listing: { source: "rpc", ids: 2 } });
  const thrown = fetcher({ pinned: () => { throw new Error("offline"); } });
  expect(await run(thrown, page())).toMatchObject({ scanned: 2 });
  const repeated = fetcher({ pinned: () => new Response(wrap("MaZiqc", [[entry(B, "again")]])) });
  expect(await run(repeated, page())).toMatchObject({ scanned: 2 });
});

const failures: Array<[string, () => Response | Promise<Response>, string]> = [
  ["a non-200 response", () => new Response("x", { status: 500 }), "http_500"],
  ["a forbidden response", () => new Response("x", { status: 403 }), "http_403"],
  ["a body with no batchexecute entry", () => new Response("not batchexecute"), "parse_error"],
  ["an inner payload that is not JSON", () => new Response(wrap("MaZiqc", "{broken")), "parse_error"],
  ["a response for another RPC", () => new Response(wrap("other", [[entry(A, "x")]])), "parse_error"],
  ["a thrown fetch", () => { throw new Error("offline"); }, "network"],
  ["a response body that cannot be read", () => ({ ok: true, status: 200, headers: new Headers(), text: async () => { throw new Error("cut"); } }) as unknown as Response, "network"],
  ["a payload with no conversation ids", () => new Response(wrap("MaZiqc", [[["x", "y"]], null])), "zero_ids"],
  ["an empty inner payload", () => new Response(wrap("MaZiqc", [])), "zero_ids"],
  ["a null inner payload", () => new Response(wrap("MaZiqc", "null")), "zero_ids"],
];
for (const [name, recent, reason] of failures) {
  test(`${name} degrades to provider_listing_empty with reason ${reason}`, async () => {
    const f = fetcher({ recent, pinned: recent });
    const error = await run(f, page()).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderListingEmptyError);
    expect((error as ProviderListingEmptyError).listing).toMatchObject({ rpc: reason, ids: 0, hidden: true });
    expect((error as ProviderListingEmptyError).listing).not.toHaveProperty("source");
    expect(f.detail()).toHaveLength(0);
  });
}

test("a failed RPC listing on an install that never synced is still a failure, not an ok with nothing scanned", async () => {
  for (const recent of [() => new Response("x", { status: 500 }), () => new Response("garbage")]) {
    await expect(run(fetcher({ recent, pinned: recent }), page(), { lastSync: null })).rejects.toBeInstanceOf(ProviderListingEmptyError);
  }
});

test("a well-formed list with no chats keeps a brand-new account clean and records why", async () => {
  const empty = () => new Response(wrap("MaZiqc", [[]]));
  const result = await run(fetcher({ recent: empty, pinned: empty }), page(), { lastSync: null });
  expect(result).toMatchObject({ scanned: 0, listing: { rpc: "zero_ids" } });
});

test("missing bootstrap data skips the RPC and records why", async () => {
  const f = fetcher();
  const error = await run(f, page({ wiz: false })).catch((e) => e);
  expect(error).toBeInstanceOf(ProviderListingEmptyError);
  expect((error as ProviderListingEmptyError).listing).toMatchObject({ rpc: "no_token" });
  expect(f.list()).toHaveLength(0);
});

test("a rate-limited list keeps the same rate-limit error the conversation RPC raises", async () => {
  for (const status of [429, 503]) {
    const limited = () => new Response("slow down", { status, headers: { "retry-after": "7" } });
    const error = await run(fetcher({ recent: limited }), page()).catch((e) => e);
    expect(isRateLimitError(error)).toBe(true);
    expect(error).toMatchObject({ status, retryAfterMs: 7000 });
  }
});

test("a page context without the wait hook and without ids also falls back to the RPC", async () => {
  const ctx: GeminiPageContext = { listConversationIds: () => [], readWizData: () => ({ at: "csrf", bl: "build", fSid: "sid" }), readConversationDom: () => null };
  expect(await run(fetcher(), ctx)).toMatchObject({ scanned: 3, listing: { source: "rpc" } });
});
