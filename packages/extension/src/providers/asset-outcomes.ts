import { MAX_ASSET_FAILURE_POINTER_CHARS, type AssetFailureReason } from "../../../shared/src";

/**
 * Per-asset memory of capture outcomes. Every capture of a conversation re-walks all of
 * its media pointers; without this, a pointer the provider no longer serves is re-fetched
 * and re-reported on every pass. A failed asset is never given up on: every reason backs off
 * exponentially from one sync period (30 minutes) to a daily cap, and keeps retrying at that
 * cap until the owner marks the asset ignored at the receiver. A changed download input (a
 * fresh URL for the same pointer) is a new attempt and ignores the backoff. Successful
 * uploads clear the entry.
 */
export const TRANSIENT_RETRY_BASE_MS = 30 * 60 * 1000;
export const TRANSIENT_RETRY_MAX_MS = 24 * 60 * 60 * 1000;
export const MAX_REMEMBERED_OUTCOMES = 5000;
/** One storage key per asset, named by a digest of its identity: pointers can be whole data: URLs. */
const KEY_PREFIX = "scrobbler.assetOutcome:";

export interface RememberedAssetOutcome {
  reason: AssetFailureReason;
  attempts: number;
  last_attempt_at: number;
  /** When the backoff ends. Informational: the schedule is recomputed from attempts, so entries
   *  written by the 30 day rest build wake on the new schedule. */
  retry_after: number | null;
  /** Limit in force when the asset was too large; a raised limit earns an immediate attempt. */
  max_bytes: number | null;
  /** Digest of the failed attempt's download input (URL or inline payload size); a different input is a new attempt. */
  input?: string | null;
  /** The receiver said the owner ignored this asset: ordinary captures stop attempting it. */
  ignored?: boolean;
}

export interface RememberDetails { input?: string | null; ignored?: boolean; }

export interface AssetOutcomeMemory {
  recall(key: string): Promise<RememberedAssetOutcome | null>;
  remember(key: string, reason: AssetFailureReason, maxBytes: number, now?: number, details?: RememberDetails): Promise<void>;
  forget(key: string): Promise<void>;
}

export function assetOutcomeKey(candidate: { source: string; sourceId: string; messageId?: string | null; pointer: string }): string {
  return JSON.stringify([candidate.source, candidate.sourceId, candidate.messageId ?? null, candidate.pointer]);
}

export function transientRetryDelayMs(attempts: number): number {
  return Math.min(TRANSIENT_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), TRANSIENT_RETRY_MAX_MS);
}

/** Identifies what would be downloaded without storing it: URLs can carry signatures. Null when there is no input. */
export async function assetInputDigest(candidate: { url?: string | null; inlineBytes?: Uint8Array; inlineBase64?: string }): Promise<string | null> {
  const text = candidate.url ? `url:${candidate.url}`
    : candidate.inlineBytes ? `inline:${candidate.inlineBytes.length}`
    : candidate.inlineBase64 !== undefined ? `inline:${candidate.inlineBase64.length}` : null;
  if (text === null) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function nextAssetOutcome(previous: RememberedAssetOutcome | null, reason: AssetFailureReason, maxBytes: number, now = Date.now(), details: RememberDetails = {}): RememberedAssetOutcome {
  const attempts = (previous?.attempts ?? 0) + 1;
  return {
    reason, attempts, last_attempt_at: now,
    retry_after: now + transientRetryDelayMs(attempts),
    max_bytes: reason === "asset_too_large" ? maxBytes : null,
    input: details.input ?? null,
    ignored: details.ignored === true,
  };
}

/** True while this asset should not be attempted. `input` digests the current candidate's download input. */
export function skipRememberedAttempt(entry: RememberedAssetOutcome, now: number, maxBytes: number, input: string | null): boolean {
  if (entry.ignored) return true;
  if ((entry.input ?? null) !== input) return false;
  if (entry.reason === "asset_too_large" && entry.max_bytes !== null && maxBytes > entry.max_bytes) return false;
  return now < entry.last_attempt_at + transientRetryDelayMs(entry.attempts);
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
    async remember(key, reason, maxBytes, now = Date.now(), details) {
      const stored = await storageKey(key);
      await set({ [stored]: nextAssetOutcome((await get(stored))[stored] ?? null, reason, maxBytes, now, details) });
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
