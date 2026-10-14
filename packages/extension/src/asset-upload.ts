import { assetsUrl, type UploadedAsset } from "../../shared/src";
import type { AssetUploadRequest } from "./messages";
import { TransientSyncError } from "./providers/sync-errors";
import { lookupSize, validateAssetAcknowledgement } from "./asset-acknowledgement";

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
  const lookup = await receiverFetch(fetcher, lookupUrl.toString(), { headers, credentials: "omit", signal: AbortSignal.timeout(30_000) });
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
  let response = await receiverFetch(fetcher, url.toString(), { method: "POST", headers, credentials: "omit", body: found ? undefined : bytes, signal: AbortSignal.timeout(60_000) });
  // Blob collection can race the lookup. Missing reference falls back to the bytes we already fetched.
  if (found && response.status === 404) {
    url.pathname = url.pathname.replace(/\/reference$/, "");
    url.searchParams.delete("sha256");
    response = await receiverFetch(fetcher, url.toString(), { method: "POST", headers, credentials: "omit", body: bytes, signal: AbortSignal.timeout(60_000) });
  }
  if (!response.ok) throw new Error(response.status === 413 ? "asset_too_large" : `Ingest rejected asset (${response.status})`);
  return validateAssetAcknowledgement(await response.json().catch(() => null), { pointer: asset.pointer, sha256, sizeBytes: bytes.length });
}

export async function lookupAssetByHash(fetcher: typeof fetch, settings: ReceiverSettings, asset: Omit<AssetUploadRequest, "bytes">, sha256: string): Promise<UploadedAsset | null> {
  const url = new URL(assetsUrl(settings.ingestBaseUrl));
  url.searchParams.set("sha256", sha256);
  const headers: Record<string, string> = settings.ingestToken ? { authorization: `Bearer ${settings.ingestToken}` } : {};
  const lookup = await receiverFetch(fetcher, url.toString(), { headers, credentials: "omit", signal: AbortSignal.timeout(30_000) });
  if (lookup.status === 404 || lookup.status === 405) return null;
  if (!lookup.ok) throw new TransientSyncError("Receiver asset lookup rejected");
  const lookupBody = await lookup.json() as { exists?: boolean };
  if (!lookupBody.exists) return null;
  url.pathname += "/reference";
  url.searchParams.set("source", asset.source);
  url.searchParams.set("source_id", asset.sourceId);
  url.searchParams.set("pointer", asset.pointer);
  if (asset.messageId) url.searchParams.set("message_id", asset.messageId);
  if (asset.filename) url.searchParams.set("filename", asset.filename);
  if (asset.contentType) url.searchParams.set("content_type", asset.contentType);
  const response = await receiverFetch(fetcher, url.toString(), { method: "POST", headers, credentials: "omit", signal: AbortSignal.timeout(30_000) });
  if (response.status === 404 || response.status === 410) return null;
  if (!response.ok) throw new TransientSyncError("Receiver asset reference rejected");
  return validateAssetAcknowledgement(await response.json().catch(() => null), { pointer: asset.pointer, sha256, sizeBytes: lookupSize(lookupBody) });
}
async function receiverFetch(fetcher: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try { response = await fetcher(url, init); } catch { throw new TransientSyncError("Receiver asset network unavailable"); }
  if (response.status >= 500 || response.status === 429) throw new TransientSyncError("Receiver asset temporarily unavailable");
  return response;
}
