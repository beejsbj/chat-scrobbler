import type { ProviderSource } from "../../../shared/src";
import { allowedAssetUrl } from "./asset-url";
import { RateLimitError, parseRetryAfterMs } from "./types";
import { TransientSyncError } from "./sync-errors";

/**
 * A response that is not the asset (a sign-in redirect, an interstitial page, an error document)
 * can be a passing provider state, so it is reported as a transient download failure. Only a
 * pointer with no usable URL before any fetch is `asset_url_unavailable`, which rests for 30 days.
 */
export const UNEXPECTED_ASSET_RESPONSE = "asset_download_failed";

/** Each request uses manual redirects; this validates the final response after checked hops. */
export function validateAssetResponse(response: Response, source: ProviderSource): void {
  if (response.status === 429 || response.status === 503) throw new RateLimitError("Provider asset", response.status, parseRetryAfterMs(response.headers.get("retry-after")));
  if (response.status >= 500) throw new TransientSyncError(`Provider asset temporarily unavailable (${response.status})`);
  if (response.type === "opaqueredirect" || response.status >= 300 && response.status < 400
    || response.url && !allowedAssetUrl(response.url, source)) throw new Error(UNEXPECTED_ASSET_RESPONSE);
}

/** Never archive a login/session document disguised as a binary asset. */
export function validateAssetBytes(bytes: Uint8Array, contentType?: string | null): void {
  if (/(?:json|html)/i.test(contentType ?? "")) throw new Error(UNEXPECTED_ASSET_RESPONSE);
  let start = 0;
  while (start < bytes.length && [9, 10, 13, 32].includes(bytes[start])) start++;
  const prefix = new TextDecoder().decode(bytes.subarray(start, start + 16 * 1024)).replace(/^\uFEFF/, "").trimStart();
  if (/^(?:<!doctype\s+html|<html\b|<head\b|<body\b)/i.test(prefix)
    || /^[{\[]/.test(prefix)) {
    throw new Error(UNEXPECTED_ASSET_RESPONSE);
  }
}
