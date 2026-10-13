import { MAX_CAPTURE_ATTEMPTS, type ConversationCaptureFailure, type ProviderSource } from "../../../shared/src";

export function logSyncFailure(source: ProviderSource, sourceId: string): void {
  console.error(JSON.stringify({ event: "conversation_capture_failed", source, source_id: sourceId, reason: "capture_failed" }));
}

/** State is carried by the background worker in chrome.storage, surviving tab/worker restarts. */
export class SyncFailureTracker {
  private failures: Map<string, ConversationCaptureFailure>;
  constructor(previous: ConversationCaptureFailure[] = []) {
    this.failures = new Map(previous.map(f => [f.source_id, { ...f }]));
  }
  isQuarantined(id: string, updatedAt: string | null): boolean {
    const previous = this.failures.get(id);
    if (previous && (previous.updated_at !== updatedAt || previous.retry_after && Date.parse(previous.retry_after) <= Date.now())) { this.failures.delete(id); return false; }
    return previous?.quarantined === true;
  }
  failed(id: string, updatedAt: string | null): void {
    const previous = this.failures.get(id);
    const attempts = (previous?.updated_at === updatedAt ? previous.attempts : 0) + 1;
    this.failures.set(id, { source_id: id, updated_at: updatedAt, attempts, quarantined: attempts >= MAX_CAPTURE_ATTEMPTS,
      ...(updatedAt === null && attempts >= MAX_CAPTURE_ATTEMPTS ? { retry_after: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() } : {}) });
  }
  succeeded(id: string): void { this.failures.delete(id); }
  get pending(): boolean { return [...this.failures.values()].some(f => !f.quarantined); }
  list(): ConversationCaptureFailure[] { return [...this.failures.values()]; }
}
