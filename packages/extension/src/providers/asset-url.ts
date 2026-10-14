import type { ProviderSource } from "../../../shared/src";

const ORIGINS: Record<ProviderSource, string[]> = {
  chatgpt: ["https://chatgpt.com", "https://chat.openai.com"],
  claude: ["https://claude.ai"], gemini: ["https://gemini.google.com"],
};
const ID = "[A-Za-z0-9_-]+";
const CHATGPT_DOWNLOAD = new RegExp(`^/backend-api/(?:files/(?:download/${ID}|${ID}/download)|conversation/${ID}/(?:attachment/${ID}/download|interpreter/download))$`);
const CLAUDE_DOWNLOAD = new RegExp(`^/api/organizations/${ID}/(?:files/${ID}/(?:download|preview)|(?:conversations|chat_conversations)/${ID}/wiggle/download-file)$`);

function assetUrl(value: string, source?: ProviderSource): URL | null {
  if (!source || !ORIGINS[source] || value !== value.trim() || /[\\\x00-\x20]/.test(value) || value.startsWith("//")) return null;
  try {
    const url = new URL(value, ORIGINS[source][0]);
    if (url.protocol !== "https:" || url.username || url.password || url.port || /%(?:2f|5c|2e)/i.test(url.pathname)) return null;
    return url;
  } catch { return null; }
}

export function providerDownloadUrl(value: string, source?: ProviderSource): boolean {
  const url = assetUrl(value, source);
  if (!url || !source || !ORIGINS[source].includes(url.origin)) return false;
  if (source === "chatgpt") return CHATGPT_DOWNLOAD.test(url.pathname)
    || url.pathname === "/backend-api/estuary/content" && /^file[-_][A-Za-z0-9_-]+$/.test(url.searchParams.get("id") ?? "");
  if (source === "claude") return CLAUDE_DOWNLOAD.test(url.pathname);
  return false;
}

export function assetAbsoluteUrl(value: string, source: ProviderSource): string | null {
  return assetUrl(value, source)?.href ?? null;
}

export function allowedAssetUrl(value: string, source?: ProviderSource): boolean {
  const url = assetUrl(value, source);
  if (!url || !source) return false;
  if (providerDownloadUrl(value, source)) return true;
  // These are media services, not general provider API origins. Credentials remain source-specific.
  if (url.pathname === "/" || /^\/(?:api|backend-api|auth|accounts)(?:\/|$)/.test(url.pathname)) return false;
  if (source === "chatgpt") return url.hostname === "oaidalleapiprodscus.blob.core.windows.net"
    || /^(?:[a-z0-9-]+\.)?oaiusercontent\.com$/.test(url.hostname);
  if (source === "claude") return /^(?:[a-z0-9-]+\.)?claudeusercontent\.com$/.test(url.hostname);
  return /^lh[3-6]\.googleusercontent\.com$/.test(url.hostname)
    || /^rr\d+---sn-[a-z0-9-]+\.googlevideo\.com$/.test(url.hostname) && url.pathname === "/videoplayback";
}

export function assetCredentials(value: string, source?: ProviderSource): RequestCredentials {
  if (!allowedAssetUrl(value, source)) return "omit";
  return providerDownloadUrl(value, source) || source === "gemini" ? "include" : "omit";
}

export function useBackgroundForAsset(url: string): boolean {
  if (!/^https:\/\//.test(url) || typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return false;
  return typeof location !== "undefined" && new URL(url).origin !== location.origin;
}
