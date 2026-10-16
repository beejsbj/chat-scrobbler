import { monitorWrite } from "../../../src/monitor/state-fault";
import { ASSET_FAILURE_REASONS } from "../../shared/src";
import { monitorStatePath, readMonitorCounter, recordAssetFailureOutcomes, type AssetFailureRecord } from "../../../src/monitor/state";

/** Extensions digest longer pointers before reporting; anything beyond this is malformed. */
const MAX_REPORTED_POINTER_CHARS = 1024;

export function assetFailureCount(indexPath: string, statePath?: string | null): number {
  try { return readMonitorCounter(monitorStatePath(indexPath, statePath), "asset_failures"); }
  catch { return 0; }
}

export function recordAssetFailures(indexPath: string, source: string, value: unknown, statePath?: string | null): number {
  if (value === undefined) return 0;
  if (!Array.isArray(value) || value.length > 100) throw new Error("asset_failures must be an array of at most 100 reports");
  const failures: AssetFailureRecord[] = value.map(item => {
    if (!item || typeof item.source_id !== "string" || !ASSET_FAILURE_REASONS.includes(item.reason) || (item.message_id != null && typeof item.message_id !== "string")
      || (item.pointer != null && (typeof item.pointer !== "string" || item.pointer.length > MAX_REPORTED_POINTER_CHARS))) throw new Error("invalid asset failure report");
    return { source_id: item.source_id, message_id: item.message_id ?? null, reason: item.reason, pointer: item.pointer ?? null };
  });
  // Pointers can be signed URLs: they belong in the per-asset record, never in logs.
  for (const failure of failures) console.error(JSON.stringify({ event: "asset_capture_failed", source, source_id: failure.source_id, message_id: failure.message_id, reason: failure.reason }));
  if (!failures.length) return 0;
  const path = monitorStatePath(indexPath, statePath);
  monitorWrite(path, () => recordAssetFailureOutcomes(path, source, failures));
  return failures.length;
}
