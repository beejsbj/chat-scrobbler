import type { AssetFailure, AssetFailureReason, ProviderSource, UploadedAsset } from "../../../shared/src";
import type { AssetFetchResponse, AssetUploadRequest } from "../messages";
import type { FetchLike, ProviderSyncOptions } from "./types";

export const MAX_PROVIDER_ASSET_BYTES = 50 * 1024 * 1024;

export interface ProviderAssetBytes {
  bytes: number[];
  filename?: string | null;
  contentType?: string | null;
}

export interface UploadProviderAssetsOptions {
  maxBytes?: number;
  reportFailure?: (failure: AssetFailure) => Promise<void>;
  fetchAsset?: (url: string) => Promise<AssetFetchResponse>;
}

export interface ProviderAssetCandidate {
  source: ProviderSource;
  sourceId: string;
  pointer: string;
  url: string;
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
  const maxBytes = options.maxBytes ?? MAX_PROVIDER_ASSET_BYTES;
  const uploaded: UploadedAsset[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.pointer || seen.has(candidate.pointer)) continue;
    seen.add(candidate.pointer);
    let reason: AssetFailureReason = "asset_download_failed";
    try {
      const downloaded = candidate.fetchViaBackground
        ? await (options.fetchAsset ?? fetchAssetViaBackground)(candidate.url)
        : await fetchCandidateBytes(fetcher, candidate.url, maxBytes);
      if (downloaded.bytes.length > maxBytes) throw new Error("asset_too_large");
      const contentType = candidate.contentType ?? downloaded.contentType ?? null;
      const filename = candidate.filename ?? downloaded.filename ?? null;
      const request: AssetUploadRequest = {
        messageId: candidate.messageId,
        originalUrl: candidate.url,
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
      if (error instanceof Error && error.message === "asset_too_large") reason = "asset_too_large";
      const failure: AssetFailure = { source: candidate.source, source_id: candidate.sourceId, message_id: candidate.messageId ?? null, reason };
      console.error(JSON.stringify({ event: "asset_capture_failed", ...failure }));
      try { await (options.reportFailure ?? reportAssetFailure)(failure); }
      catch { console.error(JSON.stringify({ event: "asset_failure_report_failed", source: candidate.source, source_id: candidate.sourceId })); }
    }
  }
  return uploaded;
}

async function fetchAssetViaBackground(url: string): Promise<ProviderAssetBytes> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    throw new Error("Background asset fetch is unavailable");
  }
  const response = await new Promise<any>((resolve) => {
    chrome.runtime.sendMessage({ type: "SCROBBLER_ASSET_FETCH", url }, resolve);
  });
  if (!response?.ok) throw new Error(response?.error ?? "Background asset fetch failed");
  return {
    bytes: Array.isArray(response.bytes) ? response.bytes : [],
    filename: response.filename ?? null,
    contentType: response.contentType ?? null,
  };
}

async function fetchCandidateBytes(
  fetcher: FetchLike,
  url: string,
  maxBytes: number,
): Promise<ProviderAssetBytes> {
  const res = await fetcher(url, { credentials: "include" });
  if (!res.ok) throw new Error("asset_download_failed");
  if (isOversizedContentLength(res.headers.get("content-length"), maxBytes)) throw new Error("asset_too_large");
  const buffer = await res.arrayBuffer();
  if (buffer.byteLength > maxBytes) throw new Error("asset_too_large");
  return {
    bytes: Array.from(new Uint8Array(buffer)),
    filename: filenameFromHeaders(res),
    contentType: res.headers.get("content-type"),
  };
}

export function isOversizedContentLength(value: string | null, maxBytes = MAX_PROVIDER_ASSET_BYTES): boolean {
  if (!value) return false;
  const bytes = Number(value);
  return Number.isFinite(bytes) && bytes > maxBytes;
}

export function filenameFromHeaders(res: Response): string | null {
  const disposition = res.headers.get("content-disposition");
  const match = disposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  return match ? decodeURIComponent(match[1]) : null;
}

async function reportAssetFailure(failure: AssetFailure): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
  const response = await new Promise<any>(resolve => chrome.runtime.sendMessage({ type: "SCROBBLER_ASSET_FAILURE", failure }, resolve));
  if (!response?.ok) throw new Error("asset failure report rejected");
}
