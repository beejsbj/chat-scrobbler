import type { ProviderSource } from "../../../shared/src";
import type { FetchLike } from "./types";
import { allowedAssetUrl, assetCredentials, assetAbsoluteUrl, providerDownloadUrl } from "./asset-url";
import { UNEXPECTED_ASSET_RESPONSE, validateAssetResponse } from "./asset-response";
import { TransientSyncError } from "./sync-errors";

export interface AssetFetchTimeouts { headerMs: number; bodyMs: number; }
export const DEFAULT_ASSET_FETCH_TIMEOUTS: AssetFetchTimeouts = { headerMs: 60_000, bodyMs: 300_000 };

/** Inspect each visible Location before following. Opaque redirects fail closed. */
export async function fetchAllowedAsset(fetcher: FetchLike, input: string, source: ProviderSource, headers?: Record<string, string>, timeouts: AssetFetchTimeouts = DEFAULT_ASSET_FETCH_TIMEOUTS): Promise<{ response: Response; url: string }> {
  // The headers deadline covers every redirect hop. A response that arrived keeps the signal until
  // bodyMs, so a large asset can finish streaming; the abort is harmless once the body is read.
  const controller = new AbortController();
  const headerTimer = setTimeout(() => controller.abort(), timeouts.headerMs);
  try {
    const result = await followAllowedAsset(fetcher, input, source, headers, controller.signal);
    setTimeout(() => controller.abort(), timeouts.bodyMs);
    return result;
  } finally { clearTimeout(headerTimer); }
}

async function followAllowedAsset(fetcher: FetchLike, input: string, source: ProviderSource, headers: Record<string, string> | undefined, signal: AbortSignal): Promise<{ response: Response; url: string }> {
  let url = input;
  for (let hop = 0; hop <= 5; hop++) {
    if (!allowedAssetUrl(url, source)) throw new Error("asset_url_unavailable");
    let response: Response;
    try { response = await fetcher(url, { credentials: assetCredentials(url, source), headers: providerDownloadUrl(url, source) ? headers : undefined, redirect: "manual", signal }); }
    catch { throw new TransientSyncError("Provider asset network unavailable"); }
    if (response.type === "opaqueredirect" || response.url && !allowedAssetUrl(response.url, source)) {
      await response.body?.cancel();
      throw new Error(UNEXPECTED_ASSET_RESPONSE);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (hop === 5 || !location || location !== location.trim() || location.startsWith("//") || /[\\\x00-\x20]/.test(location)) throw new Error(UNEXPECTED_ASSET_RESPONSE);
      url = new URL(location, response.url || assetAbsoluteUrl(url, source)!).href;
      if (!allowedAssetUrl(url, source)) throw new Error(UNEXPECTED_ASSET_RESPONSE);
      continue;
    }
    validateAssetResponse(response, source);
    return { response, url: response.url || url };
  }
  throw new Error(UNEXPECTED_ASSET_RESPONSE);
}
