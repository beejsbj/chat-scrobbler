import type { RawCapture } from "../../shared/src";
import { ReceiverSyncError } from "./providers/sync-errors";

/** A single POST is acknowledged only by an archive receipt or its tombstone. */
export function captureAcknowledged(value: unknown, capture: Pick<RawCapture, "source" | "source_id">): boolean {
  const ack = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
  if (ack?.ok === true && ack.count === 1) return true;
  if (ack?.ok === true && ack.count === 0 && Array.isArray(ack.skipped_deleted)
    && ack.skipped_deleted.some(item => item && typeof item === "object"
      && item.source === capture.source && item.source_id === capture.source_id)) return false;
  throw new ReceiverSyncError("Receiver acknowledgement invalid; check the receiver URL and proxy");
}
