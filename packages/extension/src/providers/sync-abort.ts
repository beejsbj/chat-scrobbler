import type { ConversationCaptureFailure } from "../../../shared/src";

// Keep the original error class (rate limit, receiver, detail outage) intact.
const snapshots = new WeakMap<object, ConversationCaptureFailure[]>();
export function captureFailuresOnAbort(error: unknown): ConversationCaptureFailure[] | undefined {
  return error && typeof error === "object" ? snapshots.get(error) : undefined;
}
export function abortWithFailures(error: unknown, failures: ConversationCaptureFailure[]): never {
  if (error && typeof error === "object") snapshots.set(error, failures);
  throw error;
}
