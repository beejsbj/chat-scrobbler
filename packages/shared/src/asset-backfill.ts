import type { ProviderSource, UploadedAsset } from "./raw-capture";
/** Most assets one POST /assets/backfill may carry; the receiver rejects more and the extension commits in chunks of this size. */
export const BACKFILL_MAX_ASSETS = 1000;
/** Largest POST /assets/backfill body the receiver reads; the extension keeps each commit under it. */
export const BACKFILL_MAX_BODY_BYTES = 1024 * 1024;
export interface AssetBackfillReference {
  pointer: string;
  message_id: string | null;
  filename: string | null;
  content_type: string | null;
}
export interface AssetBackfillSession {
  source_id: string;
  references: AssetBackfillReference[];
}
export interface AssetBackfillPage { ok: true; sessions: AssetBackfillSession[]; next_after: string | null; }
export interface AssetBackfillCommit { source: ProviderSource; source_id: string; assets: UploadedAsset[]; }
