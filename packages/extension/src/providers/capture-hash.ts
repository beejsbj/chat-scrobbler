import type { ProviderSource } from "../../../shared/src";
const RECAPTURE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Only acknowledged captures set the watermark; outages leave the chat eligible. */
export async function captureHash(source: ProviderSource, id: string, payload: unknown) {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return { unchanged: false, remember: async () => {} };
  const settings = await get("scrobbler.settings");
  const key = `scrobbler.captureHash:${settings?.ingestBaseUrl ?? "default"}:${source}:${id}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(payload)));
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  const previous = await get(key);
  // Periodic re-posts repair restored receivers even when their URL stays the same.
  // Old string-only entries have no acknowledgement age and must be captured once.
  const age = Date.now() - previous?.acknowledgedAt;
  return { unchanged: previous?.hash === hash && age >= 0 && age < RECAPTURE_AFTER_MS,
    remember: () => new Promise<void>(resolve => chrome.storage.local.set({ [key]: { hash, acknowledgedAt: Date.now() } }, resolve)) };
}
function get(key: string): Promise<any> { return new Promise(resolve => chrome.storage.local.get(key, (values: Record<string, any>) => resolve(values[key]))); }
