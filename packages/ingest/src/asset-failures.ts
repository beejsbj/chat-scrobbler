import { monitorWrite } from "../../../src/monitor/state-fault";
import { ASSET_FAILURE_REASONS } from "../../shared/src";
import { clearSessionAssetOutcomes, monitorStatePath, readMonitorCounter, recordAssetFailureOutcomes, type AssetFailureRecord } from "../../../src/monitor/state";
import { isSessionDeleted } from "../../../src/store/tombstones";

/** Extensions digest longer pointers before reporting; anything beyond this is malformed. */
const MAX_REPORTED_POINTER_CHARS = 1024;

export function assetFailureCount(indexPath: string, statePath?: string | null): number {
  try { return readMonitorCounter(monitorStatePath(indexPath, statePath), "asset_failures"); }
  catch { return 0; }
}

/**
 * `ignored` lists reported pointers the owner marked ignored, and those of deleted sessions; those are
 * answered, not counted. Reports for a deleted session are never recorded: deletion clears its monitor rows.
 */
export function recordAssetFailures(indexPath: string, source: string, value: unknown, statePath?: string | null, canonicalDir?: string | null): { count: number; ignored: string[] } {
  if (value === undefined) return { count: 0, ignored: [] };
  if (!Array.isArray(value) || value.length > 100) throw new Error("asset_failures must be an array of at most 100 reports");
  const failures: AssetFailureRecord[] = value.map(item => {
    if (!item || typeof item.source_id !== "string" || !ASSET_FAILURE_REASONS.includes(item.reason) || (item.message_id != null && typeof item.message_id !== "string")
      || (item.pointer != null && (typeof item.pointer !== "string" || item.pointer.length > MAX_REPORTED_POINTER_CHARS))) throw new Error("invalid asset failure report");
    return { source_id: item.source_id, message_id: item.message_id ?? null, reason: item.reason, pointer: item.pointer ?? null };
  });
  // Pointers can be signed URLs: they belong in the per-asset record, never in logs.
  for (const failure of failures) console.error(JSON.stringify({ event: "asset_capture_failed", source, source_id: failure.source_id, message_id: failure.message_id, reason: failure.reason }));
  if (!failures.length) return { count: 0, ignored: [] };
  const path = monitorStatePath(indexPath, statePath);
  const deleted = (failure: AssetFailureRecord) => !!canonicalDir && isSessionDeleted(canonicalDir, source, failure.source_id);
  const gone = failures.filter(deleted);
  const live = failures.filter(failure => !gone.includes(failure));
  const ignoredForDeleted = gone.flatMap(failure => failure.pointer ? [failure.pointer] : []);
  if (!live.length) return { count: failures.length, ignored: ignoredForDeleted };
  // If the state cannot be written, nothing is answered as ignored: the extension simply backs off and retries.
  const ignored = monitorWrite(path, () => recordAssetFailureOutcomes(path, source, live)) ?? [];
  // Deletion writes its tombstone before it clears these rows, so a tombstone seen now means its clearing may
  // have run before this write: clear again. None seen now means any later deletion clears this write.
  if (canonicalDir) for (const sourceId of new Set(live.map(failure => failure.source_id))) {
    if (isSessionDeleted(canonicalDir, source, sourceId)) monitorWrite(path, () => clearSessionAssetOutcomes(path, source, sourceId));
  }
  return { count: failures.length, ignored: [...ignoredForDeleted, ...ignored] };
}
