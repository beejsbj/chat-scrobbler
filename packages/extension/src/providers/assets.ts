import type { AssetFailure, AssetFailureReason, ProviderSource, UploadedAsset } from "../../../shared/src";
import type { AssetFetchResponse, AssetUploadRequest } from "../messages";
import { isRateLimitError, type FetchLike, type ProviderSyncOptions } from "./types";
import { allowedAssetUrl, useBackgroundForAsset } from "./asset-url";
import { fetchAllowedAsset } from "./asset-fetch";
import { isGeminiPageBlob, fetchGeminiPageBlob, validateGeminiPageBlobResponse } from "./gemini-page-blob";
import { boundedAssetBuffer } from "./asset-bytes";
import { validateAssetBytes, validateAssetResponse } from "./asset-response";
import { lookupCapturedAsset, backgroundAssetError, paceAssetDownload } from "./asset-cache-client";

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
  inlineBytes?: Uint8Array;
  inlineBase64?: string;
  /** A resolver may receive bytes directly, instead of download-link JSON. Consume them once. */
  downloadResponse?: Response;
  /** Set only from the current Gemini page's audio/video/source elements. Never from API data. */
  providerPageBlob?: boolean;
  sha256?: string | null;
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
  let downloadBlock: unknown;
  for (const candidate of candidates) {
    if (!candidate.pointer || seen.has(`${candidate.messageId ?? ""}:${candidate.pointer}`)) continue;
    seen.add(`${candidate.messageId ?? ""}:${candidate.pointer}`);
    let reason: AssetFailureReason = "asset_download_failed";
    try {
      if (candidate.url && !candidateUrlAllowed(candidate.url, candidate)) throw new Error("asset_url_unavailable");
      const cached = await lookupCapturedAsset(candidate);
      if (cached) { uploaded.push({ ...cached, pointer: candidate.pointer, message_id: candidate.messageId ?? null }); continue; }
      if (downloadBlock) throw downloadBlock;
      await (options.beforeFetch ?? paceAssetDownload)();
      const url = options.resolveUrl ? await options.resolveUrl(candidate) : candidate.url;
      const inlineBytes = candidate.inlineBytes ?? (candidate.inlineBase64 !== undefined
        ? Uint8Array.from(atob(candidate.inlineBase64), char => char.charCodeAt(0)) : undefined);
      if (!inlineBytes && (!url || !candidateUrlAllowed(url, candidate))) throw new Error("asset_url_unavailable");
      const pageBlobId = candidate.providerPageBlob && candidate.source === "gemini" && isGeminiPageBlob(url!, candidate.sourceId) ? candidate.sourceId : undefined;
      const downloaded = inlineBytes ? { bytes: inlineBytes, contentType: candidate.contentType } : candidate.downloadResponse
        ? await fetchCandidateBytes(fetcher, url!, maxBytes, candidate.headers, candidate.source, candidate.downloadResponse, pageBlobId)
        : (candidate.fetchViaBackground || useBackgroundForAsset(url!))
        ? await (options.fetchAsset ?? ((url) => fetchAssetViaBackground(url, maxBytes, candidate)))(url!)
        : await fetchCandidateBytes(fetcher, url!, maxBytes, candidate.headers, candidate.source, undefined, pageBlobId);
      if (downloaded.asset) {
        uploaded.push({ ...downloaded.asset, pointer: candidate.pointer, message_id: candidate.messageId ?? downloaded.asset.message_id ?? null });
        continue;
      }
      if (downloaded.bytes.length > maxBytes) throw new Error("asset_too_large");
      validateAssetBytes(new Uint8Array(downloaded.bytes), downloaded.contentType);
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
      // Throttling stops further downloads in this batch, while every skipped asset is reported.
      if (isRateLimitError(error)) downloadBlock = error;
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
  if (!response?.ok) throw backgroundAssetError(response);
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
  source: ProviderSource = "chatgpt",
  prefetched?: Response,
  pageBlobId?: string,
): Promise<ProviderAssetBytes> {
  const res = prefetched ?? (pageBlobId ? await fetchGeminiPageBlob(fetcher, url, pageBlobId) : (await fetchAllowedAsset(fetcher, url, source, headers)).response);
  if (pageBlobId) validateGeminiPageBlobResponse(res, url, pageBlobId);
  else validateAssetResponse(res, source);
  if (!res.ok) throw new Error(res.status === 404 || res.status === 410 ? "asset_expired" : "asset_download_failed");
  const bytes = await boundedAssetBuffer(res, maxBytes);
  return {
    bytes,
    filename: filenameFromHeaders(res),
    contentType: res.headers.get("content-type"),
  };
}

function candidateUrlAllowed(url: string, candidate: ProviderAssetCandidate): boolean {
  return allowedAssetUrl(url, candidate.source) || candidate.providerPageBlob === true
    && candidate.source === "gemini" && isGeminiPageBlob(url, candidate.sourceId);
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
  let downloadBlock: unknown;
  return candidates.flatMap(candidate => {
    const key = JSON.stringify([candidate.messageId ?? null, candidate.pointer]);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ pointer: candidate.pointer, message_id: candidate.messageId ?? null, filename: candidate.filename ?? null, content_type: candidate.contentType ?? null }];
  });
}
