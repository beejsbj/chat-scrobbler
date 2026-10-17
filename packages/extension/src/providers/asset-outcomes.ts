import { isTerminalAssetFailure, MAX_ASSET_FAILURE_POINTER_CHARS, type AssetFailureReason } from "../../../shared/src";

/**
 * Per-asset memory of capture outcomes. Every capture of a conversation re-walks all of
 * its media pointers; without this, a pointer the provider no longer serves is re-fetched
 * and re-reported on every pass. Terminal outcomes rest for 30 days, because a provider
 * may serve a pointer again (Gemini pointers are often the URL itself); transient ones
 * back off from one sync period up to a day. Successful uploads clear the entry.
 */
export const TRANSIENT_RETRY_BASE_MS = 30 * 60 * 1000;
export const TRANSIENT_RETRY_MAX_MS = 24 * 60 * 60 * 1000;
export const TERMINAL_RETRY_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_REMEMBERED_OUTCOMES = 5000;
const KEY = "scrobbler.assetOutcomes";

export interface RememberedAssetOutcome {
  reason: AssetFailureReason;
  attempts: number;
  last_attempt_at: number;
  /** Next eligible attempt. Null only for asset_too_large, which waits for a raised limit. */
  retry_after: number | null;
  /** Limit in force when the asset was too large; a raised limit earns one more attempt. */
  max_bytes: number | null;
}

export interface AssetOutcomeMemory {
  recall(key: string): Promise<RememberedAssetOutcome | null>;
  remember(key: string, reason: AssetFailureReason, maxBytes: number, now?: number): Promise<void>;
  forget(key: string): Promise<void>;
}

export function assetOutcomeKey(candidate: { source: string; sourceId: string; messageId?: string | null; pointer: string }): string {
  return JSON.stringify([candidate.source, candidate.sourceId, candidate.messageId ?? null, candidate.pointer]);
}

export function transientRetryDelayMs(attempts: number): number {
  return Math.min(TRANSIENT_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), TRANSIENT_RETRY_MAX_MS);
}

export function nextAssetOutcome(previous: RememberedAssetOutcome | null, reason: AssetFailureReason, maxBytes: number, now = Date.now()): RememberedAssetOutcome {
  const attempts = (previous?.attempts ?? 0) + 1;
  return {
    reason, attempts, last_attempt_at: now,
    retry_after: reason === "asset_too_large" ? null : now + (isTerminalAssetFailure(reason) ? TERMINAL_RETRY_MS : transientRetryDelayMs(attempts)),
    max_bytes: reason === "asset_too_large" ? maxBytes : null,
  };
}

export function skipRememberedAttempt(entry: RememberedAssetOutcome, now: number, maxBytes: number): boolean {
  if (entry.reason === "asset_too_large") return entry.max_bytes !== null && maxBytes <= entry.max_bytes;
  const retryAfter = entry.retry_after ?? (isTerminalAssetFailure(entry.reason) ? entry.last_attempt_at + TERMINAL_RETRY_MS : null);
  return retryAfter !== null && now < retryAfter;
}

/** Pointers can be whole data: URLs; the receiver records identity, not bytes. */
export async function reportablePointer(pointer: string): Promise<string> {
  if (pointer.length <= MAX_ASSET_FAILURE_POINTER_CHARS) return pointer;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pointer));
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

let writes = Promise.resolve();

/** chrome.storage.local backed; shared by every provider tab of this install. */
export function createAssetOutcomeMemory(maxEntries = MAX_REMEMBERED_OUTCOMES): AssetOutcomeMemory {
  const read = (): Promise<Record<string, RememberedAssetOutcome>> => new Promise(resolve =>
    chrome.storage.local.get(KEY, (values: Record<string, any>) => resolve(values[KEY] ?? {})));
  const write = (entries: Record<string, RememberedAssetOutcome>): Promise<void> => new Promise(resolve => chrome.storage.local.set({ [KEY]: entries }, resolve));
  const serialized = (mutate: (entries: Record<string, RememberedAssetOutcome>) => boolean): Promise<void> => {
    const job = writes.catch(() => {}).then(async () => {
      const entries = await read();
      if (mutate(entries)) await write(entries);
    });
    writes = job;
    return job;
  };
  return {
    async recall(key) { return (await read())[key] ?? null; },
    remember(key, reason, maxBytes, now = Date.now()) {
      return serialized(entries => {
        entries[key] = nextAssetOutcome(entries[key] ?? null, reason, maxBytes, now);
        const excess = Object.keys(entries).length - maxEntries;
        if (excess > 0) {
          for (const [stale] of Object.entries(entries).sort((a, b) => a[1].last_attempt_at - b[1].last_attempt_at).slice(0, excess)) delete entries[stale];
        }
        return true;
      });
    },
    forget(key) { return serialized(entries => { if (!(key in entries)) return false; delete entries[key]; return true; }); },
  };
}

/** Outside the extension there is no storage, and unit tests must not share outcomes. */
export function defaultAssetOutcomeMemory(): AssetOutcomeMemory | null {
  return typeof chrome !== "undefined" && chrome.storage?.local ? createAssetOutcomeMemory() : null;
}
