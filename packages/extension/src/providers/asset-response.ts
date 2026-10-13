import type { ProviderSource } from "../../../shared/src";
import { allowedAssetUrl } from "./asset-url";

/** Redirects are disabled on the request; verify final URLs too for custom fetch implementations. */
export function validateAssetResponse(response: Response, source: ProviderSource): void {
  if (response.type === "opaqueredirect" || response.status >= 300 && response.status < 400
    || response.url && !allowedAssetUrl(response.url, source)) throw new Error("asset_url_unavailable");
}

/** Never archive a login/session document disguised as a binary asset. */
export function validateAssetBytes(bytes: Uint8Array, contentType?: string | null): void {
  if (/(?:json|html)/i.test(contentType ?? "")) throw new Error("asset_url_unavailable");
  let start = 0;
  while (start < bytes.length && [9, 10, 13, 32].includes(bytes[start])) start++;
  const prefix = new TextDecoder().decode(bytes.subarray(start, start + 16 * 1024)).replace(/^\uFEFF/, "").trimStart();
  if (/^(?:<!doctype\s+html|<html\b|<head\b|<body\b)/i.test(prefix)
    || /^[{\[]/.test(prefix) && /"(?:access_?token|refresh_?token|session|authorization|csrf|cookies?|token)"\s*:/i.test(prefix)) {
    throw new Error("asset_url_unavailable");
  }
}
