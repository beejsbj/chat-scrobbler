/**
 * Gemini sidebar listing. The conversation list is read from the rendered sidebar, which Gemini fills
 * asynchronously after load (and which a background tab may never render), so listing waits, bounded,
 * for it and records counts that tell the possible causes of an empty list apart.
 */

/** Counts and flags only: never ids, titles, hrefs or text. */
export interface ListingDiagnostic {
  /** Conversation ids found. */
  ids: number;
  /** `a[href*="/app/"]` anchors present. */
  appAnchors: number;
  /** All `a[href]` anchors present (0 means the page itself has not rendered). */
  anchors: number;
  /** Sidebar-like containers present (nav, aside, role=navigation, sidenav/sidebar classes). */
  containers: number;
  /** The document was hidden when the wait ended (a background tab). */
  hidden: boolean;
  readyState: string | null;
  waitedMs: number;
  timedOut: boolean;
}

/** Timers in a background tab are throttled to about 1s, so nothing here depends on fine timing. */
export const geminiListingTimings = { timeoutMs: 20_000, pollMs: 500, settleMs: 1_500 };

const CONTAINERS = 'nav, aside, [role="navigation"], [class*="sidenav" i], [class*="sidebar" i], [class*="side-nav" i]';

/**
 * The conversation id in a sidebar href, or null. Accepts relative and absolute hrefs, an account prefix
 * (`/u/1/app/<id>`), and a query or hash. Ids are hex; 16 is what Gemini uses today, a wider range is accepted
 * so a longer id does not silently empty the list.
 */
export function geminiConversationIdFromHref(href: string, base = "https://gemini.google.com/app"): string | null {
  let url: URL;
  try { url = new URL(href, base); } catch { return null; }
  if (url.hostname !== "gemini.google.com") return null;
  return url.pathname.match(/^(?:\/u\/\d+)?\/app\/([0-9a-f]{12,32})(?:\/|$)/i)?.[1] ?? null;
}

function pageBase(): string {
  return typeof location !== "undefined" && location.href ? location.href : "https://gemini.google.com/app";
}

export function readSidebarIds(): string[] {
  if (typeof document === "undefined") return [];
  const base = pageBase();
  const ids = new Set<string>();
  for (const anchor of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/app/"]'))) {
    const id = geminiConversationIdFromHref(anchor.getAttribute("href") ?? "", base);
    if (id) ids.add(id);
  }
  return [...ids];
}

function diagnose(ids: number, started: number, timedOut: boolean): ListingDiagnostic {
  const count = (selector: string) => typeof document === "undefined" ? 0 : document.querySelectorAll(selector).length;
  return {
    ids, appAnchors: count('a[href*="/app/"]'), anchors: count("a[href]"), containers: count(CONTAINERS),
    hidden: typeof document !== "undefined" && (document.hidden === true || document.visibilityState === "hidden"),
    readyState: typeof document === "undefined" ? null : document.readyState ?? null,
    waitedMs: Date.now() - started, timedOut,
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Poll until the sidebar lists conversations or the bound passes; after the first sighting, allow a short settle so a partial render is not taken as the whole list. */
export async function waitForSidebarIds(): Promise<{ ids: string[]; diagnostic: ListingDiagnostic }> {
  const { timeoutMs, pollMs, settleMs } = geminiListingTimings;
  const started = Date.now();
  let ids = readSidebarIds();
  while (ids.length === 0 && Date.now() - started < timeoutMs) { await sleep(pollMs); ids = readSidebarIds(); }
  if (ids.length > 0 && settleMs > 0) { await sleep(settleMs); ids = readSidebarIds(); }
  return { ids, diagnostic: diagnose(ids.length, started, ids.length === 0) };
}
