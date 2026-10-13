/** Categorical diagnostics. Provider bodies, URLs and credentials are never reported. */
export interface SyncIssue {
  reason: "receiver_unavailable" | "provider_detail_outage" | "sync_unavailable";
  status?: number;
  occurred_at: string;
}
