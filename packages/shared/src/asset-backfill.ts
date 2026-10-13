import type { ProviderSource, UploadedAsset } from "./raw-capture";
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
