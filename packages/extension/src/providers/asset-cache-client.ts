import type { UploadedAsset } from "../../../shared/src";
import type { ProviderAssetCandidate } from "./assets";
import { RateLimitError } from "./types";
import { TransientSyncError } from "./sync-errors";

export async function lookupCapturedAsset(candidate: ProviderAssetCandidate): Promise<UploadedAsset | null> {
  if (typeof chrome === "undefined" || !chrome.storage?.local || !chrome.runtime?.sendMessage) return null;
  const response = await new Promise<any>(resolve => chrome.runtime.sendMessage({ type: "SCROBBLER_ASSET_LOOKUP", asset: {
    source: candidate.source, sourceId: candidate.sourceId, pointer: candidate.pointer, messageId: candidate.messageId,
    filename: candidate.filename, contentType: candidate.contentType, sha256: candidate.sha256,
  } }, resolve));
  if (!response?.ok) throw new TransientSyncError("Receiver asset lookup unavailable");
  return response.asset ?? null;
}
export function backgroundAssetError(response: any): Error {
  if (response?.error_type === "rate_limit") return new RateLimitError("Provider asset", response.status ?? 429, response.retryAfterMs ?? null);
  if (response?.error_type === "transient") return new TransientSyncError("Asset transfer temporarily unavailable");
  return new Error(response?.error ?? "Asset transfer failed");
}
export async function paceAssetDownload(): Promise<void> {
  if (typeof chrome !== "undefined" && chrome.storage?.local) await new Promise(resolve => setTimeout(resolve, 1000));
}
