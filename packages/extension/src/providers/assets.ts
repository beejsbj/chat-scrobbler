import type { AssetFailure, AssetFailureReason, ProviderSource, UploadedAsset } from "../../../shared/src";
import type { AssetFetchResponse, AssetUploadRequest } from "../messages";
import type { FetchLike, ProviderSyncOptions } from "./types";
import { allowedAssetUrl, assetCredentials, useBackgroundForAsset } from "./asset-url";
import { boundedAssetBuffer } from "./asset-bytes";

export const MAX_PROVIDER_ASSET_BYTES = 100 * 1024 * 1024;

export interface ProviderAssetBytes {
  bytes: number[] | Uint8Array;
  asset?: UploadedAsset;
  filename?: string | null;
  contentType?: string | null;
}

export interface UploadProviderAssetsOptions {
  maxBytes?: number;
  reportFailure?: (failure: AssetFailure) => Promise<void>;
  fetchAsset?: (url: string) => Promise<AssetFetchResponse>;
  beforeFetch?: () => Promise<void>;
  resolveUrl?: (candidate: ProviderAssetCandidate) => Promise<string | null>;
}

export interface ProviderAssetCandidate {
  source: ProviderSource;
  sourceId: string;
  pointer: string;
  url: string | null;
  /** Applied only to same-origin provider requests, never forwarded to ingest or CDNs. */
  headers?: Record<string, string>;
  filename?: string | null;
  contentType?: string | null;
  messageId?: string | null;
  fetchViaBackground?: boolean;
}

export async function uploadProviderAssets(
  fetcher: FetchLike,
  uploadAsset: ProviderSyncOptions["uploadAsset"],
  candidates: ProviderAssetCandidate[],
  options: UploadProviderAssetsOptions = {},
): Promise<UploadedAsset[]> {
  if (!uploadAsset || candidates.length === 0) return [];
  const maxBytes = options.maxBytes ?? await configuredAssetLimit();
  const uploaded: UploadedAsset[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.pointer || seen.has(`${candidate.messageId ?? ""}:${candidate.pointer}`)) continue;
    seen.add(`${candidate.messageId ?? ""}:${candidate.pointer}`);
    let reason: AssetFailureReason = "asset_download_failed";
    try {
      await options.beforeFetch?.();
      const url = options.resolveUrl ? await options.resolveUrl(candidate) : candidate.url;
      if (!url || !allowedAssetUrl(url)) throw new Error("asset_url_unavailable");
      const downloaded = (candidate.fetchViaBackground || useBackgroundForAsset(url))
        ? await (options.fetchAsset ?? ((url) => fetchAssetViaBackground(url, maxBytes, candidate)))(url)
        : await fetchCandidateBytes(fetcher, url, maxBytes, candidate.headers, candidate.source);
      if (downloaded.asset) {
        uploaded.push({ ...downloaded.asset, pointer: candidate.pointer, message_id: candidate.messageId ?? downloaded.asset.message_id ?? null });
        continue;
      }
      if (downloaded.bytes.length > maxBytes) throw new Error("asset_too_large");
      const contentType = assetContentType(downloaded.contentType, candidate.contentType);
      const filename = candidate.filename ?? downloaded.filename ?? null;
      const request: AssetUploadRequest = {
        messageId: candidate.messageId,
        originalUrl: url,
        source: candidate.source,
        sourceId: candidate.sourceId,
        pointer: candidate.pointer,
        filename,
        contentType,
        bytes: downloaded.bytes,
      };
      reason = "asset_upload_failed";
      const asset = await uploadAsset(request);
      uploaded.push({
        ...asset,
        pointer: candidate.pointer,
        message_id: candidate.messageId ?? asset.message_id ?? null,
        filename: filename ?? asset.filename ?? null,
        content_type: contentType ?? asset.content_type ?? null,
      });
    } catch (error) {
      if (error instanceof Error && ["asset_too_large", "asset_url_unavailable", "asset_expired", "asset_upload_failed"].includes(error.message)) reason = error.message as AssetFailureReason;
      const failure: AssetFailure = { source: candidate.source, source_id: candidate.sourceId, message_id: candidate.messageId ?? null, reason };
      console.error(JSON.stringify({ event: "asset_capture_failed", ...failure }));
      try { await (options.reportFailure ?? reportAssetFailure)(failure); }
      catch { console.error(JSON.stringify({ event: "asset_failure_report_failed", source: candidate.source, source_id: candidate.sourceId })); }
    }
  }
  return uploaded;
}

async function fetchAssetViaBackground(url: string, maxBytes: number, candidate: ProviderAssetCandidate): Promise<ProviderAssetBytes> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    throw new Error("Background asset fetch is unavailable");
  }
  const response = await new Promise<any>((resolve) => {
    chrome.runtime.sendMessage({ type: "SCROBBLER_ASSET_FETCH", url, maxBytes, upload: { source: candidate.source, sourceId: candidate.sourceId, pointer: candidate.pointer, messageId: candidate.messageId, filename: candidate.filename, contentType: candidate.contentType, originalUrl: url } }, resolve);
  });
  if (!response?.ok) throw new Error(response?.error ?? "Background asset fetch failed");
  return {
    asset: response.asset,
    bytes: Array.isArray(response.bytes) ? response.bytes : [],
    filename: response.filename ?? null,
    contentType: response.contentType ?? null,
  };
}

async function fetchCandidateBytes(
  fetcher: FetchLike,
  url: string,
  maxBytes: number,
  headers?: Record<string, string>,
  source?: ProviderSource,
): Promise<ProviderAssetBytes> {
  const sameOrigin = url.startsWith("/") && !url.startsWith("//")
    || (typeof location !== "undefined" && new URL(url, location.origin).origin === location.origin);
  const res = await fetcher(url, { credentials: assetCredentials(url, source), headers: sameOrigin ? headers : undefined, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(res.status === 404 || res.status === 410 ? "asset_expired" : "asset_download_failed");
  const bytes = await boundedAssetBuffer(res, maxBytes);
  return {
    bytes,
    filename: filenameFromHeaders(res),
    contentType: res.headers.get("content-type"),
  };
}

export function isOversizedContentLength(value: string | null, maxBytes = MAX_PROVIDER_ASSET_BYTES): boolean {
  if (!value) return false;
  const bytes = Number(value);
  return Number.isFinite(bytes) && bytes > maxBytes;
}

/** An actual response type is more reliable than positional provider metadata. */
export function assetContentType(responseType?: string | null, hint?: string | null): string | null {
  return responseType && responseType.split(";")[0].trim().toLowerCase() !== "application/octet-stream"
    ? responseType : hint ?? responseType ?? null;
}

export function filenameFromHeaders(res: Response): string | null {
  const disposition = res.headers.get("content-disposition");
  const match = disposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return match[1]; }
}

async function reportAssetFailure(failure: AssetFailure): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
  const response = await new Promise<any>(resolve => chrome.runtime.sendMessage({ type: "SCROBBLER_ASSET_FAILURE", failure }, resolve));
  if (!response?.ok) throw new Error("asset failure report rejected");
}

async function configuredAssetLimit(): Promise<number> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return MAX_PROVIDER_ASSET_BYTES;
  const stored = await new Promise<Record<string, any>>(resolve => chrome.storage.local.get("scrobbler.settings", resolve));
  const limit = stored["scrobbler.settings"]?.maxAssetBytes;
  return typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0 ? limit : MAX_PROVIDER_ASSET_BYTES;
}

export function assetReferences(candidates: ProviderAssetCandidate[]): import("../../../shared/src").AssetBackfillReference[] {
  const seen = new Set<string>();
  return candidates.flatMap(candidate => {
    const key = JSON.stringify([candidate.messageId ?? null, candidate.pointer]);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ pointer: candidate.pointer, message_id: candidate.messageId ?? null, filename: candidate.filename ?? null, content_type: candidate.contentType ?? null }];
  });
}
