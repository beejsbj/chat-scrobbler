import { afterEach, beforeEach, expect, test } from "bun:test";
import { createBrowserPageContext, createGeminiAdapter, type GeminiPageContext } from "../packages/extension/src/providers/gemini";
import { geminiConversationIdFromHref, geminiListingTimings, type ListingDiagnostic } from "../packages/extension/src/providers/gemini-sidebar";
import { ProviderListingEmptyError } from "../packages/extension/src/providers/sync-errors";
import { syncErrorResponse } from "../packages/extension/src/sync-error-response";

const originalDocument = (globalThis as { document?: unknown }).document;
const originalLocation = (globalThis as { location?: unknown }).location;
afterEach(() => {
  (globalThis as { document?: unknown }).document = originalDocument;
  (globalThis as { location?: unknown }).location = originalLocation;
});
beforeEach(() => { geminiListingTimings.timeoutMs = 60; geminiListingTimings.pollMs = 1; geminiListingTimings.settleMs = 5; });

const ID = "1a2b3c4d5e6f7a8b";
const diagnostic: ListingDiagnostic = { ids: 0, appAnchors: 0, anchors: 3, containers: 1, hidden: true, readyState: "complete", waitedMs: 20_000, timedOut: true };
const rpc = async () => new Response(")]}'\n\n" + JSON.stringify([["wrb.fr", "hNvQHb", JSON.stringify([["c"]]), null, null, null, "generic"]]));

function page(list: () => { ids: string[]; diagnostic?: ListingDiagnostic }): GeminiPageContext {
  return { listConversationIds: () => list().ids, awaitConversationIds: async () => ({ ids: list().ids, diagnostic: list().diagnostic ?? diagnostic }),
    readWizData: () => ({ at: "csrf", bl: "b", fSid: "s" }), readConversationDom: () => null };
}
const sync = (ctx: GeminiPageContext, options: Record<string, unknown> = {}) => createGeminiAdapter(rpc, ctx).sync({ emitCapture: async () => true, ...options });

test("an empty listing after the wait is a failure with its own reason once this install has synced Gemini before", async () => {
  const error = await sync(page(() => ({ ids: [] })), { lastSync: "2026-10-20T00:00:00Z" }).catch((e) => e);
  expect(error).toBeInstanceOf(ProviderListingEmptyError);
  expect(syncErrorResponse(error)).toMatchObject({ ok: false, syncIssue: { reason: "provider_listing_empty" }, listingDiagnostic: diagnostic });
});

test("an empty listing is also a failure when earlier chat failures are on record", async () => {
  const failures = [{ source_id: ID, updated_at: null, attempts: 1, quarantined: false }];
  await expect(sync(page(() => ({ ids: [] })), { captureFailures: failures })).rejects.toBeInstanceOf(ProviderListingEmptyError);
});

test("a brand-new account (nothing ever synced) with no chats stays a clean sync but keeps the diagnostic", async () => {
  const result = await sync(page(() => ({ ids: [] })));
  expect(result).toMatchObject({ scanned: 0, listing: diagnostic });
});

test("a non-empty listing syncs and carries the listing diagnostic", async () => {
  const seen = { ...diagnostic, ids: 1, timedOut: false };
  const result = await sync(page(() => ({ ids: [ID], diagnostic: seen })), { lastSync: "2026-10-20T00:00:00Z" });
  expect(result).toMatchObject({ scanned: 1, captured: 1, listing: seen });
});

test("a page context without the wait hook keeps listing synchronously", async () => {
  const ctx: GeminiPageContext = { listConversationIds: () => [ID], readWizData: () => ({ at: "csrf", bl: "b", fSid: "s" }), readConversationDom: () => null };
  expect(await sync(ctx)).toMatchObject({ scanned: 1 });
});

function fakeDocument(hrefs: () => string[], opts: { hidden?: boolean; containers?: number } = {}) {
  const anchor = (href: string) => ({ getAttribute: (n: string) => n === "href" ? href : null });
  (globalThis as { location?: unknown }).location = { href: "https://gemini.google.com/app" };
  (globalThis as { document?: unknown }).document = {
    visibilityState: opts.hidden ? "hidden" : "visible", hidden: !!opts.hidden, readyState: "complete",
    querySelectorAll: (selector: string) => {
      if (selector === "a[href]") return hrefs().map(anchor);
      if (selector.includes("/app/")) return hrefs().filter((h) => h.includes("/app/")).map(anchor);
      return Array.from({ length: opts.containers ?? 0 }, () => ({}));
    },
  };
}

test("the browser context waits for a sidebar that renders after the call", async () => {
  let reads = 0;
  fakeDocument(() => (++reads > 4 ? [`/app/${ID}`] : []));
  const listing = await createBrowserPageContext().awaitConversationIds!();
  expect(listing.ids).toEqual([ID]);
  expect(listing.diagnostic).toMatchObject({ ids: 1, timedOut: false });
});

test("the wait is bounded and reports counts only when nothing ever renders", async () => {
  fakeDocument(() => ["/settings", "https://example.com/app/x"], { hidden: true, containers: 2 });
  const listing = await createBrowserPageContext().awaitConversationIds!();
  expect(listing.ids).toEqual([]);
  expect(listing.diagnostic).toMatchObject({ ids: 0, appAnchors: 1, anchors: 2, containers: 2, hidden: true, readyState: "complete", timedOut: true });
  expect(Object.values(listing.diagnostic).every((v) => typeof v === "number" || typeof v === "boolean" || typeof v === "string" || v === null)).toBe(true);
  expect(JSON.stringify(listing.diagnostic)).not.toContain("settings");
});

test("sidebar hrefs: relative, absolute, account-prefixed and query forms resolve; look-alikes do not", () => {
  const base = "https://gemini.google.com/app";
  const id = (href: string) => geminiConversationIdFromHref(href, base);
  expect(id(`/app/${ID}`)).toBe(ID);
  expect(id(`/app/${ID}/`)).toBe(ID);
  expect(id(`/app/${ID}?hl=en`)).toBe(ID);
  expect(id(`https://gemini.google.com/app/${ID}`)).toBe(ID);
  expect(id(`/u/2/app/${ID}`)).toBe(ID);
  expect(id(`app/${ID}`)).toBe(ID);
  expect(id("/app/0123456789abcdef0123")).toBe("0123456789abcdef0123");
  for (const bad of ["/app", "/app/download", "/app/abc", `/gem/${ID}`, `https://example.com/app/${ID}`, "javascript:void(0)", "", `/app/${ID}x`]) expect(id(bad)).toBeNull();
});
