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
/** Deterministic for a given pointer: the provider no longer serves it, or it never had a URL. Retrying cannot help. */
export const TERMINAL_ASSET_FAILURE_REASONS: readonly AssetFailureReason[] = ["asset_expired", "asset_url_unavailable", "asset_too_large"];
export const MAX_ASSET_FAILURE_POINTER_CHARS = 512;
export function isTerminalAssetFailure(reason: string): boolean { return TERMINAL_ASSET_FAILURE_REASONS.includes(reason as AssetFailureReason); }
