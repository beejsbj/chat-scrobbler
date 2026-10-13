/** An outage must never become a permanent conversation failure. */
export class TransientSyncError extends Error {
  constructor(message = "Capture temporarily unavailable") { super(message); this.name = "TransientSyncError"; }
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
/** An isolated detail 5xx belongs to a chat; three consecutive ones suggest an outage. */
export class DetailFailureStreak {
  private consecutive = 0;
  succeeded(): void { this.consecutive = 0; }
  failed(error: unknown): void {
    this.consecutive = error instanceof ProviderDetailError && error.status! >= 500 ? this.consecutive + 1 : 0;
    if (this.consecutive >= 3) throw new TransientSyncError("Provider detail endpoints repeatedly unavailable");
    abortTransientCapture(error);
  }
}
