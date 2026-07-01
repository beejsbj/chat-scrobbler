import type { ProviderSource, UploadedAsset } from "../../../shared/src";
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
    try {
      const downloaded = candidate.fetchViaBackground
        ? await (options.fetchAsset ?? fetchAssetViaBackground)(candidate.url)
        : await fetchCandidateBytes(fetcher, candidate.url, maxBytes);
      if (!downloaded) continue;
      if (downloaded.bytes.length > maxBytes) continue;
      const contentType = candidate.contentType ?? downloaded.contentType ?? null;
      const filename = candidate.filename ?? downloaded.filename ?? null;
      const request: AssetUploadRequest = {
        source: candidate.source,
        sourceId: candidate.sourceId,
        pointer: candidate.pointer,
        filename,
        contentType,
        bytes: downloaded.bytes,
      };
      const asset = await uploadAsset(request);
      uploaded.push({
        ...asset,
        pointer: candidate.pointer,
        message_id: candidate.messageId ?? asset.message_id ?? null,
        filename: filename ?? asset.filename ?? null,
        content_type: contentType ?? asset.content_type ?? null,
      });
    } catch {
      // Provider asset URLs often expire or reject even when conversation JSON is
      // readable. Keep text capture working and leave local_path null.
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
): Promise<ProviderAssetBytes | null> {
  const res = await fetcher(url, { credentials: "include" });
  if (!res.ok) return null;
  if (isOversizedContentLength(res.headers.get("content-length"), maxBytes)) return null;
  const buffer = await res.arrayBuffer();
  if (buffer.byteLength > maxBytes) return null;
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
