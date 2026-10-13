import type { ProviderSource } from "../../../shared/src";

export function logSyncFailure(source: ProviderSource, sourceId: string): void {
  console.error(JSON.stringify({ event: "conversation_capture_failed", source, source_id: sourceId, reason: "capture_failed" }));
}
