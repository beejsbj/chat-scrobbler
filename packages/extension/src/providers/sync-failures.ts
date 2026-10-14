import { MAX_CAPTURE_ATTEMPTS, type ConversationCaptureFailure, type ProviderSource } from "../../../shared/src";
import { abortWithFailures } from "./sync-abort";
import { ProviderDetailError, ProviderDetailOutageError } from "./sync-errors";

export function logSyncFailure(source: ProviderSource, sourceId: string): void {
  console.error(JSON.stringify({ event: "conversation_capture_failed", source, source_id: sourceId, reason: "capture_failed" }));
}

/** State is carried by the background worker in chrome.storage, surviving tab/worker restarts. */
export class SyncFailureTracker {
  private failures: Map<string, ConversationCaptureFailure>;
  private seen = new Set<string>();
  private beforeEscalation: Map<string, ConversationCaptureFailure>;
  constructor(previous: ConversationCaptureFailure[] = []) {
    this.failures = new Map(previous.map(f => [f.source_id, { ...f }]));
    this.beforeEscalation = new Map(previous.map(f => [f.source_id, { ...f }]));
  }
  isQuarantined(id: string, updatedAt: string | null): boolean {
    const previous = this.failures.get(id);
    if (previous && previous.updated_at !== updatedAt) { this.failures.delete(id); return false; }
    if (previous?.quarantined && (!previous.retry_after || Date.parse(previous.retry_after) <= Date.now())) return false;
    return previous?.quarantined === true;
  }
  failed(id: string, updatedAt: string | null, error?: unknown): void {
    const previous = this.failures.get(id);
    const attempts = (previous?.updated_at === updatedAt ? previous.attempts : 0) + 1;
    this.failures.set(id, { source_id: id, updated_at: updatedAt, attempts, quarantined: attempts >= MAX_CAPTURE_ATTEMPTS,
      ...(attempts >= MAX_CAPTURE_ATTEMPTS ? { retry_after: new Date(Date.now() + [1, 3, 7][Math.min(attempts - MAX_CAPTURE_ATTEMPTS, 2)] * 24 * 60 * 60 * 1000).toISOString() } : {}) });
    if (!(error instanceof ProviderDetailError && (error.status ?? 0) >= 500)) this.beforeEscalation.set(id, this.failures.get(id)!);
  }
  succeeded(id: string): void { this.failures.delete(id); this.beforeEscalation.delete(id); }
  abort(error: unknown): never {
    return abortWithFailures(error, error instanceof ProviderDetailOutageError ? [...this.beforeEscalation.values()] : this.list());
  }
  observed(id: string): void { this.seen.add(id); }
  shouldRetry(id: string, updatedAt: string | null): boolean {
    const previous = this.failures.get(id);
    return !!previous && (previous.updated_at !== updatedAt || !this.isQuarantined(id, updatedAt));
  }
  get hasRetries(): boolean { return [...this.failures.values()].some(f => !this.isQuarantined(f.source_id, f.updated_at)); }
  finishListing(): void {
    for (const [id, failure] of this.failures) if (!failure.quarantined && !this.seen.has(id)) this.failures.delete(id);
  }
  get pending(): boolean { return [...this.failures.values()].some(f => !f.quarantined); }
  list(): ConversationCaptureFailure[] { return [...this.failures.values()]; }
}
