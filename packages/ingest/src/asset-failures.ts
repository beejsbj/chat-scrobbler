import { ASSET_FAILURE_REASONS } from "../../shared/src";
const counts = new Map<string, number>();
export function assetFailureCount(indexPath: string): number { return counts.get(indexPath) ?? 0; }

export function recordAssetFailures(indexPath: string, source: string, value: unknown): number {
  if (value === undefined) return 0;
  if (!Array.isArray(value) || value.length > 100) throw new Error("asset_failures must be an array of at most 100 reports");
  const failures = value.map(item => {
    if (!item || typeof item.source_id !== "string" || !ASSET_FAILURE_REASONS.includes(item.reason) || (item.message_id != null && typeof item.message_id !== "string")) throw new Error("invalid asset failure report");
    return { source_id: item.source_id, message_id: item.message_id ?? null, reason: item.reason };
  });
  for (const failure of failures) console.error(JSON.stringify({ event: "asset_capture_failed", source, ...failure }));
  counts.set(indexPath, assetFailureCount(indexPath) + failures.length);
  return failures.length;
}
