import type { ProviderSource } from "./raw-capture";
export type AssetFailureReason = "asset_download_failed" | "asset_too_large" | "asset_upload_failed" | "asset_url_unavailable" | "asset_expired";
export interface AssetFailure {
  source: ProviderSource;
  source_id: string;
  message_id: string | null;
  reason: AssetFailureReason;
}
export const ASSET_FAILURE_REASONS: readonly string[] = ["asset_download_failed", "asset_too_large", "asset_upload_failed", "asset_url_unavailable", "asset_expired"];
