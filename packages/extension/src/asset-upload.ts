import { assetsUrl, type UploadedAsset } from "../../shared/src";
import type { AssetUploadRequest } from "./messages";

interface ReceiverSettings { ingestBaseUrl: string; ingestToken?: string | null; maxAssetBytes: number; }

/** Provider bytes arrive without provider credentials. Only receiver auth leaves this module. */
export async function uploadAssetToIngest(fetcher: typeof fetch, settings: ReceiverSettings, asset: AssetUploadRequest): Promise<UploadedAsset> {
  if (asset.bytes.length > settings.maxAssetBytes) throw new Error("asset_too_large");
  const bytes = new Uint8Array(asset.bytes);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  const headers: Record<string, string> = {};
  if (asset.contentType) headers["content-type"] = asset.contentType;
  if (settings.ingestToken) headers.authorization = `Bearer ${settings.ingestToken}`;
  const lookupUrl = new URL(assetsUrl(settings.ingestBaseUrl));
  lookupUrl.searchParams.set("sha256", sha256);
  const lookup = await fetcher(lookupUrl.toString(), { headers, credentials: "omit", signal: AbortSignal.timeout(30_000) });
  if (!lookup.ok && lookup.status !== 404 && lookup.status !== 405) throw new Error(`Asset lookup rejected (${lookup.status})`);
  const found = lookup.ok && (await lookup.json() as { exists?: boolean }).exists === true;
  const url = new URL(assetsUrl(settings.ingestBaseUrl));
  url.searchParams.set("source", asset.source);
  url.searchParams.set("source_id", asset.sourceId);
  url.searchParams.set("pointer", asset.pointer);
  if (asset.messageId) url.searchParams.set("message_id", asset.messageId);
  if (asset.originalUrl && !asset.originalUrl.startsWith("data:")) url.searchParams.set("original_url", asset.originalUrl);
  if (asset.filename) url.searchParams.set("filename", asset.filename);
  if (asset.contentType) url.searchParams.set("content_type", asset.contentType);
  if (found) { url.pathname += "/reference"; url.searchParams.set("sha256", sha256); }
  let response = await fetcher(url.toString(), { method: "POST", headers, credentials: "omit", body: found ? undefined : bytes, signal: AbortSignal.timeout(60_000) });
  // Blob collection can race the lookup. Missing reference falls back to the bytes we already fetched.
  if (found && response.status === 404) {
    url.pathname = url.pathname.replace(/\/reference$/, "");
    url.searchParams.delete("sha256");
    response = await fetcher(url.toString(), { method: "POST", headers, credentials: "omit", body: bytes, signal: AbortSignal.timeout(60_000) });
  }
  if (!response.ok) throw new Error(response.status === 413 ? "asset_too_large" : `Ingest rejected asset (${response.status})`);
  return await response.json() as UploadedAsset;
}
