import { monitorWrite } from "../../../src/monitor/state-fault";
import { ASSET_FAILURE_REASONS } from "../../shared/src";
import { incrementMonitorCounter, monitorStatePath, readMonitorCounter } from "../../../src/monitor/state";
export function assetFailureCount(indexPath: string, statePath?: string | null): number {
  try { return readMonitorCounter(monitorStatePath(indexPath, statePath), "asset_failures"); }
  catch { return 0; }
}

export function recordAssetFailures(indexPath: string, source: string, value: unknown, statePath?: string | null): number {
  if (value === undefined) return 0;
  if (!Array.isArray(value) || value.length > 100) throw new Error("asset_failures must be an array of at most 100 reports");
  const failures = value.map(item => {
    if (!item || typeof item.source_id !== "string" || !ASSET_FAILURE_REASONS.includes(item.reason) || (item.message_id != null && typeof item.message_id !== "string")) throw new Error("invalid asset failure report");
    return { source_id: item.source_id, message_id: item.message_id ?? null, reason: item.reason };
  });
  for (const failure of failures) console.error(JSON.stringify({ event: "asset_capture_failed", source, ...failure }));
  const path = monitorStatePath(indexPath, statePath);
  monitorWrite(path, () => incrementMonitorCounter(path, "asset_failures", failures.length));
  return failures.length;
}
