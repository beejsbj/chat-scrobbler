import type { ProviderSource } from "./raw-capture";
export type AssetFailureReason = "asset_download_failed" | "asset_too_large" | "asset_upload_failed" | "asset_url_unavailable" | "asset_expired";
export interface AssetFailure {
  source: ProviderSource;
  source_id: string;
  message_id: string | null;
  reason: AssetFailureReason;
  /** Identifies the asset for per-asset outcome records. Longer pointers travel as `sha256:<hex>`. */
  pointer?: string | null;
}
export const ASSET_FAILURE_REASONS: readonly string[] = ["asset_download_failed", "asset_too_large", "asset_upload_failed", "asset_url_unavailable", "asset_expired"];
/** Reasons the monitor reports without paging: the provider no longer serves the asset, it never had a URL, or it was over a size limit. This is a reporting class only; extensions keep retrying every failure with backoff until the owner ignores the asset. */
export const TERMINAL_ASSET_FAILURE_REASONS: readonly AssetFailureReason[] = ["asset_expired", "asset_url_unavailable", "asset_too_large"];
export const MAX_ASSET_FAILURE_POINTER_CHARS = 512;
export function isTerminalAssetFailure(reason: string): boolean { return TERMINAL_ASSET_FAILURE_REASONS.includes(reason as AssetFailureReason); }
