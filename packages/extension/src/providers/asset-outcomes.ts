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
/** One storage key per asset, named by a digest of its identity: pointers can be whole data: URLs. */
const KEY_PREFIX = "scrobbler.assetOutcome:";

export interface RememberedAssetOutcome {
  reason: AssetFailureReason;
  attempts: number;
  last_attempt_at: number;
  /** Next eligible attempt. Null only for asset_too_large, which waits for a raised limit or 30 days. */
  retry_after: number | null;
  /** Limit in force when the asset was too large; a raised limit earns one more attempt. A receiver
   *  413 is recorded against this extension limit, so the 30 day rest also covers a raised receiver limit. */
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
  if (entry.reason === "asset_too_large") return entry.max_bytes !== null && maxBytes <= entry.max_bytes && now < entry.last_attempt_at + TERMINAL_RETRY_MS;
  const retryAfter = entry.retry_after ?? (isTerminalAssetFailure(entry.reason) ? entry.last_attempt_at + TERMINAL_RETRY_MS : null);
  return retryAfter !== null && now < retryAfter;
}

/** Pointers can be whole data: URLs; the receiver records identity, not bytes. */
export async function reportablePointer(pointer: string): Promise<string> {
  if (pointer.length <= MAX_ASSET_FAILURE_POINTER_CHARS) return pointer;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pointer));
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function storageKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return KEY_PREFIX + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * chrome.storage.local backed; shared by every provider tab of this install. Each asset has its
 * own key, so tabs writing different assets at once cannot overwrite each other's outcomes.
 */
export function createAssetOutcomeMemory(maxEntries = MAX_REMEMBERED_OUTCOMES): AssetOutcomeMemory {
  const local = () => chrome.storage.local;
  const get = (key: string | null): Promise<Record<string, any>> => new Promise(resolve => local().get(key, resolve));
  const set = (values: Record<string, RememberedAssetOutcome>): Promise<void> => new Promise(resolve => local().set(values, resolve));
  const remove = (keys: string | string[]): Promise<void> => new Promise(resolve => local().remove(keys, resolve));
  const outcomeKeys = async (): Promise<string[]> => {
    const all = typeof (local() as any).getKeys === "function" ? await (local() as any).getKeys() as string[] : Object.keys(await get(null));
    return all.filter(key => key.startsWith(KEY_PREFIX));
  };
  const evict = async (): Promise<void> => {
    const keys = await outcomeKeys();
    if (keys.length <= maxEntries) return;
    const entries = await Promise.all(keys.map(async key => [key, (await get(key))[key] as RememberedAssetOutcome | undefined] as const));
    const oldest = entries.sort((a, b) => (a[1]?.last_attempt_at ?? 0) - (b[1]?.last_attempt_at ?? 0)).slice(0, keys.length - maxEntries);
    await remove(oldest.map(([key]) => key));
  };
  return {
    async recall(key) { const stored = await storageKey(key); return (await get(stored))[stored] ?? null; },
    async remember(key, reason, maxBytes, now = Date.now()) {
      const stored = await storageKey(key);
      await set({ [stored]: nextAssetOutcome((await get(stored))[stored] ?? null, reason, maxBytes, now) });
      await evict();
    },
    // Best effort: failing to clear memory must never turn a stored asset into a reported failure.
    async forget(key) { try { await remove(await storageKey(key)); } catch { /* the entry rests until it expires */ } },
  };
}

/** Outside the extension there is no storage, and unit tests must not share outcomes. */
export function defaultAssetOutcomeMemory(): AssetOutcomeMemory | null {
  return typeof chrome !== "undefined" && chrome.storage?.local ? createAssetOutcomeMemory() : null;
}
