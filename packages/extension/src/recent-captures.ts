// packages/extension/src/recent-captures.ts
// Pure, unit-tested helper for managing the recent-captures buffer that backs
// the popup's "captured this session" list.  No chrome/DOM dependencies here.

/** Whether this capture was a brand-new chat or an update to an existing one. */
export type CaptureKind = "new" | "update";

export interface RecentCapture {
  /** Provider-scoped conversation id. */
  id: string;
  /** Conversation title, truncated to TITLE_MAX_LEN characters. */
  title: string;
  /** ISO-8601 timestamp of when the capture completed. */
  capturedAt: string;
  /** Whether this was a brand-new chat or an update to an existing one. */
  kind: CaptureKind;
}

export const RECENT_CAPTURES_KEY = "scrobbler.recentCaptures";
export const RECENT_CAPTURES_CAP = 20;
export const TITLE_MAX_LEN = 80;

/**
 * Return a new buffer with `entry` inserted at position 0 (newest-first).
 *
 * Rules:
 *   - If the same `id` already exists, remove the old entry first (no duplicate).
 *   - Cap the result at `cap` entries, dropping from the tail (oldest).
 *   - The input buffer is never mutated.
 */
export function appendRecentCapture(
  buffer: RecentCapture[] | null | undefined,
  entry: RecentCapture,
  cap = RECENT_CAPTURES_CAP,
): RecentCapture[] {
  const existing = Array.isArray(buffer) ? buffer : [];
  // Remove any prior entry for the same id so re-capturing moves it to top.
  const filtered = existing.filter((e) => e.id !== entry.id);
  const next = [entry, ...filtered];
  return next.slice(0, cap);
}

/**
 * Truncate and clean a raw sidebar anchor textContent to a usable title.
 * Strips leading/trailing whitespace; respects `maxLen`.
 */
export function cleanTitle(raw: string, maxLen = TITLE_MAX_LEN): string {
  const trimmed = raw.trim().replace(/\s+/g, " ");
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen - 1) + "…" : trimmed;
}
