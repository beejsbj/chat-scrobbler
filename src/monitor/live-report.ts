import type { IngestServerOptions } from "../../packages/ingest/src/server";
import { SOURCES } from "../store/raw-catalog";
import { monitorSettings } from "./config";
import { monitorStatePath, readMonitorState } from "./state";
import { monitorWriteFailed } from "./state-fault";
import { MonitorStateError, monitorDataDir } from "./state-owner";

/** HTTP only reads the small operational database. Full checks belong to the offline CLI. */
export function liveMonitorReport(opts: IngestServerOptions) {
  const settings = monitorSettings(opts);
  const failures: string[] = [];
  let state: ReturnType<typeof readMonitorState> | null = null;
  try {
    if (!opts.indexPath) throw new Error("state not configured");
    const path = monitorStatePath(opts.indexPath, settings.monitorStatePath);
    state = readMonitorState(path, Date.now() - settings.monitorRecentHours * 3_600_000, opts.canonicalDir ? monitorDataDir(opts.canonicalDir) : undefined, false);
    if (monitorWriteFailed(path)) failures.push("FAILED state write_failed");
  } catch (error) { failures.push(`FAILED state ${error instanceof MonitorStateError ? error.reason : "unavailable"}`); }
  const providers = Object.fromEntries(SOURCES.map(source => {
    const days = settings.monitorStaleDays[source];
    const last = state?.captures[source] ?? null;
    const stale = state ? days !== null && (!last || Date.now() - Date.parse(last) > days * 86_400_000) : null;
    if (stale) failures.push(`FAILED freshness.${source} ${last ? `stale threshold_days=${days}` : "no_captures"}`);
    return [source, { last_capture_at: last, threshold_days: days, stale }];
  }));
  if (state?.recentAssets) failures.push(`FAILED assets recent_upload_failures=${state.recentAssets}`);
  failures.sort();
  return { scope: "live", ok: !failures.length, failures, providers, counters: state?.counters ?? {}, assets: { upload_failures: state?.counters.asset_failures ?? 0, recent_upload_failures: state?.recentAssets ?? 0 }, state: state ? "available" : "unavailable", deferred_checks: ["raw", "canonical", "unknown_types", "embedding_coverage", "embedding_probe", "attachments", "store_health"] };
}

const cache = new Map<string, { expires: number; report: ReturnType<typeof liveMonitorReport> }>();
export function cachedLiveMonitorReport(opts: IngestServerOptions) {
  const key = JSON.stringify([opts.indexPath, opts.canonicalDir, monitorSettings(opts)]);
  const previous = cache.get(key);
  if (previous && previous.expires > Date.now()) return previous.report;
  for (const [key, entry] of cache) if (entry.expires <= Date.now()) cache.delete(key);
  const report = liveMonitorReport(opts);
  cache.set(key, { expires: Date.now() + 60_000, report });
  return report;
}
