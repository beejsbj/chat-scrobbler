import type { ErrorResponse } from "./messages";
import { ReceiverSyncError, TransientSyncError } from "./providers/sync-errors";

export function syncErrorResponse(error: unknown): ErrorResponse {
  return { ok: false, error: error instanceof Error ? error.message : "Sync failed",
    syncIssue: { reason: error instanceof ReceiverSyncError ? "receiver_unavailable" : "sync_unavailable",
      occurred_at: new Date().toISOString(), ...(error instanceof TransientSyncError && error.status !== undefined ? { status: error.status } : {}) } };
}
