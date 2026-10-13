/** An outage must never become a permanent conversation failure. */
export class TransientSyncError extends Error {
  constructor(message = "Capture temporarily unavailable") { super(message); this.name = "TransientSyncError"; }
}
export class DeterministicCaptureError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = "DeterministicCaptureError"; }
}
export function isDeterministicCaptureError(error: unknown): boolean {
  return error instanceof SyntaxError || error instanceof DeterministicCaptureError;
}
export function abortTransientCapture(error: unknown): void {
  if (!isDeterministicCaptureError(error)) throw error instanceof TransientSyncError || (error as Error)?.name === "RateLimitError"
    ? error : new TransientSyncError();
}
