import type { DetailFailureIdentity } from "../../../shared/src";
/** An outage must never become a permanent conversation failure. */
export class TransientSyncError extends Error {
  constructor(message = "Capture temporarily unavailable", readonly status?: number) { super(message); this.name = "TransientSyncError"; }
}
export class ReceiverSyncError extends TransientSyncError {
  constructor(message: string, status?: number) { super(message, status); this.name = "ReceiverSyncError"; }
}
export class DeterministicCaptureError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = "DeterministicCaptureError"; }
}
/** Only explicitly classified environmental failures stop the run. */
export function abortTransientCapture(error: unknown): void {
  if (error instanceof TransientSyncError) throw error;
}
export class ProviderDetailError extends DeterministicCaptureError {
  constructor(status: number) { super(`Provider rejected conversation (${status})`, status); this.name = "ProviderDetailError"; }
}
export class ProviderDetailOutageError extends TransientSyncError {
  constructor(readonly detailFailureStreak: DetailFailureIdentity[]) {
    super("Provider detail endpoints repeatedly unavailable; retry later");
    this.name = "ProviderDetailOutageError";
  }
}
