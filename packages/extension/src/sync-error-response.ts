import type { ErrorResponse } from "./messages";
import { captureFailuresOnAbort } from "./providers/sync-abort";
import { ReceiverSyncError, TransientSyncError, ProviderDetailOutageError } from "./providers/sync-errors";

export function syncErrorResponse(error: unknown): ErrorResponse {
  const captureFailures = captureFailuresOnAbort(error);
  return { ok: false, ...(captureFailures ? { captureFailures } : {}), ...(error instanceof ProviderDetailOutageError ? { detailFailureStreak: error.detailFailureStreak } : {}), error: error instanceof Error ? error.message : "Sync failed",
    syncIssue: { reason: error instanceof ReceiverSyncError ? "receiver_unavailable" : error instanceof ProviderDetailOutageError ? "provider_detail_outage" : "sync_unavailable",
      occurred_at: new Date().toISOString(), ...(error instanceof TransientSyncError && error.status !== undefined ? { status: error.status } : {}) } };
}
