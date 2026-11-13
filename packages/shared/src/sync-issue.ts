/** Categorical diagnostics. Provider bodies, URLs and credentials are never reported. */
export interface SyncIssue {
  reason: "receiver_unavailable" | "provider_detail_outage" | "provider_listing_empty" | "sync_unavailable";
  status?: number;
  occurred_at: string;
}
