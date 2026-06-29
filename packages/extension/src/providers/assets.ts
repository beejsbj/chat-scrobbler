import type { ProviderSource, UploadedAsset } from "../../../shared/src";
import type { AssetUploadRequest } from "../messages";
import type { FetchLike, ProviderSyncOptions } from "./types";

export interface ProviderAssetCandidate {
  source: ProviderSource;
  sourceId: string;
  pointer: string;
  url: string;
  filename?: string | null;
  contentType?: string | null;
  messageId?: string | null;
}

export async function uploadProviderAssets(
  fetcher: FetchLike,
  uploadAsset: ProviderSyncOptions["uploadAsset"],
  candidates: ProviderAssetCandidate[],
): Promise<UploadedAsset[]> {
  if (!uploadAsset || candidates.length === 0) return [];
  const uploaded: UploadedAsset[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.pointer || seen.has(candidate.pointer)) continue;
    seen.add(candidate.pointer);
    try {
      const res = await fetcher(candidate.url, { credentials: "include" });
      if (!res.ok) continue;
      const contentType = candidate.contentType ?? res.headers.get("content-type");
      const bytes = Array.from(new Uint8Array(await res.arrayBuffer()));
      const request: AssetUploadRequest = {
        source: candidate.source,
        sourceId: candidate.sourceId,
        pointer: candidate.pointer,
        filename: candidate.filename ?? null,
        contentType,
        bytes,
      };
      const asset = await uploadAsset(request);
      uploaded.push({
        ...asset,
        pointer: candidate.pointer,
        message_id: candidate.messageId ?? asset.message_id ?? null,
        filename: candidate.filename ?? asset.filename ?? null,
        content_type: contentType ?? asset.content_type ?? null,
      });
    } catch {
      // Provider asset URLs often expire or reject even when conversation JSON is
      // readable. Keep text capture working and leave local_path null.
    }
  }
  return uploaded;
}

export function filenameFromHeaders(res: Response): string | null {
  const disposition = res.headers.get("content-disposition");
  const match = disposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  return match ? decodeURIComponent(match[1]) : null;
}
