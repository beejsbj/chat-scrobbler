// packages/extension/src/sidebar/reconcile.ts
// Pure logic for the in-page sidebar sync badges. DOM glue lives in badges.ts;
// everything here is deterministic and unit-tested.
import type { ProviderSource } from "../../../shared/src";

export type ConversationState = "synced" | "stale" | "missing" | "syncing" | "error" | "ignored";

export const CAPTURE_THROTTLE_MS = 2_500;
export const CAPTURE_RETRY_DELAY_MS = 500;
export const FULL_RECONCILE_MIN_INTERVAL_MS = 15_000;
export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
export const MAX_RATE_LIMIT_COOLDOWN_MS = 5 * 60_000;
/** Debounce applied to the active-chat fast path so we capture AFTER streaming finishes. */
export const FAST_PATH_DEBOUNCE_MS = 1_500;

/** Per-provider sidebar config: how to find chat links and pull the id out. */
export interface SidebarConfig {
  source: ProviderSource;
  /** CSS selector matching each sidebar conversation anchor. */
  linkSelector: string;
  /** Pull the conversation id out of an anchor href, or null if not a chat link. */
  idFromHref: (href: string) => string | null;
}

const afterSegment = (href: string, segment: string): string | null => {
  const trimmed = href.trim();
  if (!trimmed) return null;
  let path = trimmed;
  try {
    path = new URL(trimmed, "https://example.invalid").pathname;
  } catch { /* keep the raw path */ }
  const parts = path.split("/").filter(Boolean);
  const index = parts.indexOf(segment);
  const id = index >= 0 ? parts[index + 1] : null;
  return id ? decodeURIComponent(id) : null;
};

export const SIDEBAR_CONFIGS: Record<ProviderSource, SidebarConfig> = {
  chatgpt: {
    source: "chatgpt",
    linkSelector: 'nav a[href*="/c/"], aside a[href*="/c/"], a[href^="/c/"], a[href^="c/"], a[href*="chatgpt.com/c/"], a[href*="chat.openai.com/c/"]',
    idFromHref: (href) => afterSegment(href, "c"),
  },
  claude: {
    source: "claude",
    linkSelector: 'a[href*="/chat/"]',
    idFromHref: (href) => afterSegment(href, "chat"),
  },
  gemini: {
    source: "gemini",
    linkSelector: 'a[href^="/app/"], a[href^="app/"], a[href*="gemini.google.com/app/"]',
    idFromHref: (href) => {
      const id = afterSegment(href, "app");
      return id && /^[0-9a-f]{16}$/i.test(id) ? id : null;
    },
  },
};

export interface BadgePresentation {
  glyph: string;
  label: string;
  /** state used as a data-attribute + class hook for styling */
  state: ConversationState;
}

/** Run an async capture, retrying up to retries times on a transient (non-rate-limit) failure
 *  so a brief ingest or network blip does not flash a chat red. Rate-limit errors are rethrown
 *  immediately because the caller handles their cooldown separately. */
export async function captureWithRetry(
  attempt: () => Promise<void>,
  opts: {
    isRateLimit: (error: unknown) => boolean;
    wait?: (ms: number) => Promise<void>;
    delayMs?: number;
    retries?: number;
  },
): Promise<void> {
  const retries = opts.retries ?? 1;
  for (let i = 0; ; i++) {
    try {
      await attempt();
      return;
    } catch (error) {
      if (opts.isRateLimit(error) || i >= retries) throw error;
      await (opts.wait ?? (() => Promise.resolve()))(opts.delayMs ?? 0);
    }
  }
}

// iCloud/Drive-style: subtle SVG glyph + accessible label. Colors are applied via CSS
// keyed on the data-state attribute (see badges.ts) so we keep this pure.
// Using inline SVG strings so the glyphs are crisp at any DPI and easily themed.
const SVG = (path: string, extra = ""): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" ${extra}>${path}</svg>`;

// Filled circle (synced)
const GLYPH_SYNCED = SVG('<circle cx="5" cy="5" r="3.5" fill="currentColor"/>');
// Outlined ring (missing / not synced yet)
const GLYPH_MISSING = SVG('<circle cx="5" cy="5" r="3" fill="none" stroke="currentColor" stroke-width="1.5"/>');
// Half-filled ring (stale / needs re-sync)
const GLYPH_STALE = SVG('<circle cx="5" cy="5" r="3.5" fill="currentColor" opacity=".35"/><circle cx="5" cy="5" r="3" fill="none" stroke="currentColor" stroke-width="1.5"/>');
// Spinning arc (syncing) -- animation is applied via CSS on the badge element
const GLYPH_SYNCING = SVG('<circle cx="5" cy="5" r="3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="12 7" stroke-linecap="round"/>', 'style="display:block"');
// Exclamation dot (error)
const GLYPH_ERROR = SVG('<circle cx="5" cy="5" r="3.5" fill="currentColor"/><rect x="4.25" y="2.5" width="1.5" height="2.8" rx=".5" fill="#fff"/><circle cx="5" cy="7" r=".7" fill="#fff"/>');
// Slashed ring (ignored)
const GLYPH_IGNORED = SVG('<circle cx="5" cy="5" r="3" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M2.4 7.6 7.6 2.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>');

export function badgePresentation(state: ConversationState): BadgePresentation {
  switch (state) {
    case "synced": return { glyph: GLYPH_SYNCED, label: "Synced to history", state };
    case "stale": return { glyph: GLYPH_STALE, label: "Updated since last sync", state };
    case "syncing": return { glyph: GLYPH_SYNCING, label: "Syncing…", state };
    case "error": return { glyph: GLYPH_ERROR, label: "Sync failed", state };
    case "ignored": return { glyph: GLYPH_IGNORED, label: "Ignored", state };
    case "missing":
    default: return { glyph: GLYPH_MISSING, label: "Not synced yet", state };
  }
}

/** Conversations that auto-sync should capture, in sidebar order: anything not
 *  already current. Returns [] when auto-sync is off. */
export function captureQueue(
  statuses: Record<string, ConversationState>,
  ids: string[],
  autoSync: boolean,
): string[] {
  if (!autoSync) return [];
  return ids.filter((id) => statuses[id] === "missing" || statuses[id] === "stale");
}

export function applyIgnoredStates(
  statuses: Record<string, ConversationState>,
  ignoredIds: ReadonlySet<string>,
): Record<string, ConversationState> {
  const next = { ...statuses };
  for (const id of ignoredIds) next[id] = "ignored";
  return next;
}

export function captureDelayMs(index: number, throttleMs = CAPTURE_THROTTLE_MS): number {
  if (index <= 0) return 0;
  return Math.max(0, throttleMs);
}

export function nextCooldownMs(attempt: number, retryAfterMs: number | null = null): number {
  if (retryAfterMs !== null && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return Math.min(retryAfterMs, MAX_RATE_LIMIT_COOLDOWN_MS);
  }

  const exponent = Math.max(0, Math.floor(attempt) - 1);
  return Math.min(DEFAULT_RATE_LIMIT_COOLDOWN_MS * 2 ** exponent, MAX_RATE_LIMIT_COOLDOWN_MS);
}

export function nextFullReconcileDelayMs(
  nowMs: number,
  lastFullRunAtMs: number | null,
  retryAfterUntilMs: number,
  minIntervalMs = FULL_RECONCILE_MIN_INTERVAL_MS,
): number {
  const minIntervalUntilMs = lastFullRunAtMs === null ? nowMs : lastFullRunAtMs + minIntervalMs;
  const nextAllowedAtMs = Math.max(minIntervalUntilMs, retryAfterUntilMs);
  return Math.max(0, nextAllowedAtMs - nowMs);
}

/**
 * Decide whether a conversation should be re-captured this reconcile cycle.
 *
 * Returns true when:
 *  - The conversation has never been captured in this page-session (lastCapturedUpdatedAtMs
 *    is undefined), OR
 *  - The live updatedAt timestamp is strictly newer than the one we last captured,
 *    meaning the user has continued the conversation since we last synced it.
 *
 * Returns false in all other cases (same timestamp, older timestamp, or already
 * captured and no change observed), preventing the endless re-capture churn that
 * occurs when /status incorrectly reports a conversation as "missing" or "stale"
 * every cycle (e.g. Gemini live-session id mismatch with Takeout source_ids).
 *
 * @param lastCapturedUpdatedAtMs - Timestamp (ms) at which we last captured this
 *   conversation, or undefined if never captured in this page-session.
 * @param liveUpdatedAtMs - Current updatedAt from the provider API (ms). Callers
 *   should coerce null to 0.
 */
export function shouldRecapture(
  lastCapturedUpdatedAtMs: number | undefined,
  liveUpdatedAtMs: number,
): boolean {
  if (lastCapturedUpdatedAtMs === undefined) return true;
  return liveUpdatedAtMs > lastCapturedUpdatedAtMs;
}

/**
 * Determine the id of the conversation currently open in the main pane by
 * applying the provider's idFromHref to the page's own URL.
 *
 * Returns null when the current page is not a conversation URL (e.g. the
 * provider's landing page, settings, or a new-chat placeholder).
 *
 * This is a pure function — no DOM reads — making it fully unit-testable.
 */
export function activeConversationId(href: string, config: SidebarConfig): string | null {
  try {
    const path = new URL(href).pathname;
    return config.idFromHref(path);
  } catch {
    // href may already be a plain pathname (e.g. in tests)
    return config.idFromHref(href);
  }
}
