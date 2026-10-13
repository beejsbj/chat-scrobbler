import type { ProviderSource } from "../../../shared/src";

/** Only acknowledged captures set the watermark; outages leave the chat eligible. */
export async function captureHash(source: ProviderSource, id: string, payload: unknown) {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return { unchanged: false, remember: async () => {} };
  const settings = await get("scrobbler.settings");
  const key = `scrobbler.captureHash:${settings?.ingestBaseUrl ?? "default"}:${source}:${id}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(payload)));
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  return { unchanged: await get(key) === hash, remember: () => new Promise<void>(resolve => chrome.storage.local.set({ [key]: hash }, resolve)) };
}
function get(key: string): Promise<any> { return new Promise(resolve => chrome.storage.local.get(key, (values: Record<string, any>) => resolve(values[key]))); }
