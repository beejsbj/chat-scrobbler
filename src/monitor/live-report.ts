import type { IngestServerOptions } from "../../packages/ingest/src/server";
import { providerFreshness } from "./freshness";
import { parseFailureLines } from "./parse-state";
import { monitorSettings } from "./config";
import { monitorStatePath, readMonitorState } from "./state";
import { monitorWriteFailed } from "./state-fault";
import { MonitorStateError, monitorDataDir } from "./state-owner";
import { indexedCaptureTimes } from "./indexed-captures";
import { SOURCES } from "../store/raw-catalog";
import { skippedEmbeddingFailure } from "./skipped";

/** HTTP reads operational state and, only at bootstrap, indexed session dates. */
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
  const fallback = state && SOURCES.some(source => !state.captures[source] || !state.parsed[source]) ? indexedCaptureTimes(opts.indexPath) : {};
  const freshness = providerFreshness(settings.monitorStaleDays, { ...fallback, ...state?.captures }, { ...fallback, ...state?.parsed }, state !== null);
  const providers = freshness.providers;
  failures.push(...freshness.failures, ...parseFailureLines(state));
  if (state?.recentAssets) failures.push(`FAILED assets recent_upload_failures=${state.recentAssets}`);
  try {
    const skipped = skippedEmbeddingFailure(opts.indexPath, opts.embeddingProvider);
    if (skipped) failures.push(skipped);
  } catch { failures.push("FAILED index unreadable_or_incompatible"); }
  failures.sort();
  return { scope: "live", ok: !failures.length, failures, providers, counters: state?.counters ?? {}, parse: state?.parse ?? {}, assets: { upload_failures: state?.counters.asset_failures ?? 0, recent_upload_failures: state?.recentAssets ?? 0 }, state: state ? "available" : "unavailable", deferred_checks: ["raw", "canonical", "unknown_types", "embedding_coverage", "embedding_probe", "attachments", "store_health"] };
}

const cache = new Map<string, { expires: number; report: ReturnType<typeof liveMonitorReport> }>();
export function cachedLiveMonitorReport(opts: IngestServerOptions) {
  const key = JSON.stringify([opts.indexPath, opts.canonicalDir, monitorSettings(opts), opts.embeddingProvider?.kind?.trim(), opts.embeddingProvider?.model?.trim()]);
  const previous = cache.get(key);
  if (previous && previous.expires > Date.now()) return previous.report;
  for (const [key, entry] of cache) if (entry.expires <= Date.now()) cache.delete(key);
  const report = liveMonitorReport(opts);
  cache.set(key, { expires: Date.now() + 60_000, report });
  return report;
}
