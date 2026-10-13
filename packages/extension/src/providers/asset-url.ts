import type { ProviderSource } from "../../../shared/src";

const PROVIDER_HOSTS = new Set(["chatgpt.com", "chat.openai.com", "claude.ai", "gemini.google.com"]);
// Legacy DALL-E URLs are signed downloads on this specific Azure storage account.
const SIGNED_MEDIA_HOSTS = new Set(["oaidalleapiprodscus.blob.core.windows.net", "oaiusercontent.com", "claudeusercontent.com"]);
const CDN_SUFFIXES = [".googleusercontent.com", ".googlevideo.com", ".oaiusercontent.com", ".claudeusercontent.com"];

export function allowedAssetUrl(value: string): boolean {
  if (/^\/(?!\/)/.test(value) || /^(blob:|data:)/.test(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && (PROVIDER_HOSTS.has(url.hostname) || SIGNED_MEDIA_HOSTS.has(url.hostname)
      || CDN_SUFFIXES.some(suffix => url.hostname.endsWith(suffix)) || url.hostname === "googleusercontent.com");
  } catch { return false; }
}

export function assetCredentials(value: string, source?: ProviderSource): RequestCredentials {
  if (/^\/(?!\/)/.test(value)) return "include";
  try {
    const url = new URL(value);
    if (PROVIDER_HOSTS.has(url.hostname)) return "include";
    // Gemini media hosts can require the user's Google session. Signed OpenAI/Claude CDNs do not.
    if ((source === "gemini" || source === undefined) && (url.hostname.endsWith(".googleusercontent.com") || url.hostname.endsWith(".googlevideo.com"))) return "include";
  } catch { /* Inline bytes need no credentials. */ }
  return "omit";
}

export function useBackgroundForAsset(url: string): boolean {
  if (!/^https:\/\//.test(url) || typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return false;
  return typeof location !== "undefined" && new URL(url).origin !== location.origin;
}
