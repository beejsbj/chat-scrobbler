import { acknowledgeTypes, monitorStatePath, readMonitorState } from "./state";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { ingestHealth } from "../../packages/ingest/src/health";
import type { IngestServerOptions } from "../../packages/ingest/src/server";
import { unknownTypes } from "../core/unknown-types";
import { rawDirForCanonicalDir } from "../store/raw";
import { SOURCES } from "../store/raw-catalog";
import { monitorSettings } from "./config";
import { rawObservations } from "./raw";
import { canonicalObservations } from "./canonical";
import { embeddingCoverage } from "./coverage";

export function unknownTypeId(source: string, type: string): string {
  return createHash("sha256").update(JSON.stringify([source, type])).digest("hex").slice(0, 16);
}

export async function monitorReport(opts: IngestServerOptions, ack = false) {
  const failures: string[] = [];
  const fail = (check: string, detail: string) => failures.push(`FAILED ${check} ${detail}`);
  const settings = monitorSettings(opts);
  const since = Date.now() - settings.monitorRecentHours * 3_600_000;
  const statePath = opts.indexPath ? monitorStatePath(opts.indexPath, settings.monitorStatePath) : null;
  let state: ReturnType<typeof readMonitorState> | null = null;
  try { if (statePath) state = readMonitorState(statePath, since); else fail("state", "not_configured"); }
  catch { fail("state", "unavailable"); }
  const indexExists = opts.indexPath && existsSync(opts.indexPath);
  const health = await ingestHealth(opts, true);
  for (const store of ["index", "canonical", "raw", "assets"] as const) {
    if (!health[store].writable) fail(`store.${store}`, health[store].reason ?? "unavailable");
  }
  if (health.semantic !== "available") fail("semantic", health.semantic === "disabled" ? "disabled" : "unavailable");
  const canonicalDir = opts.canonicalDir ?? "";
  const rawDir = opts.rawDir ?? (canonicalDir ? rawDirForCanonicalDir(canonicalDir) : "");
  let raw = { lastCapture: { chatgpt: null, claude: null, gemini: null } as Record<typeof SOURCES[number], string | null>, parseFailures: 0, unprojected: 0, unreadable: 0 };
  try { if (canonicalDir && rawDir) raw = rawObservations(rawDir, canonicalDir); }
  catch { fail("raw", "scan_failed"); }
  const providers = Object.fromEntries(SOURCES.map(source => {
    const days = settings.monitorStaleDays[source];
    const last = [raw.lastCapture[source], state?.captures[source]].filter((time): time is string => !!time).sort().at(-1) ?? null;
    const stale = days !== null && (!last || Date.now() - Date.parse(last) > days * 86_400_000);
    if (stale) fail(`freshness.${source}`, last ? `stale threshold_days=${days}` : "no_captures");
    return [source, { last_capture_at: last, threshold_days: days, stale }];
  }));
  if (raw.parseFailures) fail("parse", `failed_versions_without_canonical=${raw.parseFailures}`);
  if (raw.unprojected) fail("canonical", `unprojected_raw_versions=${raw.unprojected}`);
  if (raw.unreadable) fail("raw", `unreadable_versions=${raw.unreadable}`);
  let unknown: ReturnType<typeof unknownTypes> = { counts: [], unreadable_sessions: 0, scanned_sessions: 0 };
  try { if (canonicalDir) unknown = unknownTypes(canonicalDir); }
  catch { fail("canonical", "scan_failed"); }
  const types = unknown.counts.map(row => ({ source: row.source, type_id: unknownTypeId(row.source, row.provider_type), count: row.count }));
  if (ack && statePath && state) {
    try {
      acknowledgeTypes(statePath, types.map(type => type.type_id));
      types.forEach(type => state!.acknowledged.add(type.type_id));
    } catch { fail("state", "acknowledge_failed"); }
  }
  for (const type of types.filter(type => !state?.acknowledged.has(type.type_id))) fail(`unknown.${type.source}`, `type_id=${type.type_id} count=${type.count}`);
  if (state?.recentAssets) fail("assets", `recent_upload_failures=${state.recentAssets}`);
  let missingAssets = 0;
  try {
    const canonical = canonicalObservations(canonicalDir, since);
    missingAssets = canonical.missingAssets;
    if (canonical.unreadable || unknown.unreadable_sessions) fail("canonical", `unreadable_sessions=${Math.max(canonical.unreadable, unknown.unreadable_sessions)}`);
  } catch { fail("canonical", "scan_failed"); }
  if (missingAssets) fail("assets", `missing_recent_blocks=${missingAssets}`);
  let coverage = null;
  try {
    if (opts.indexPath && indexExists) coverage = embeddingCoverage(opts.indexPath, opts.embeddingProvider ?? null, since, opts.embeddingProvider?.dimensions ?? ("embedding_dimension" in health ? health.embedding_dimension : undefined));
    if (coverage && coverage.recent_coverage < settings.monitorCoverageThreshold) fail("embeddings", `recent_with_vectors=${coverage.recent_with_vectors} recent_without_vectors=${coverage.recent_without_vectors} threshold=${settings.monitorCoverageThreshold}`);
  } catch { fail("index", "unreadable_or_incompatible"); }
  const noVectors = coverage && !coverage.with_vectors && coverage.without_vectors > 0;
  if (health.semantic === "available" && noVectors) fail("semantic", "no_usable_vectors");
  failures.sort();
  return { ok: failures.length === 0, failures, providers, unknown_types: types.map(type => ({ ...type, acknowledged: state?.acknowledged.has(type.type_id) ?? false })), embeddings: { semantic: noVectors ? "unavailable" : health.semantic, coverage }, assets: { missing_recent_blocks: missingAssets, upload_failures: state?.counters.asset_failures ?? 0, recent_upload_failures: state?.recentAssets ?? 0 }, parse: { failed_versions_without_canonical: raw.parseFailures }, counters: state?.counters ?? {}, health };
}

type Report = Awaited<ReturnType<typeof monitorReport>>;
const reports = new Map<string, { expires: number; result: Promise<Report> }>();
const providerReports = new WeakMap<object, typeof reports>();
export function cachedMonitorReport(opts: IngestServerOptions): Promise<Report> {
  let cache = reports;
  if (opts.embeddingProvider) {
    cache = providerReports.get(opts.embeddingProvider) ?? new Map();
    providerReports.set(opts.embeddingProvider, cache);
  }
  const key = JSON.stringify([opts.canonicalDir, opts.indexPath, opts.rawDir, monitorSettings(opts)]);
  const previous = cache.get(key);
  if (previous && previous.expires > Date.now()) return previous.result;
  for (const [key, entry] of cache) if (entry.expires <= Date.now()) cache.delete(key);
  const entry = { expires: Infinity, result: monitorReport(opts) };
  entry.result = entry.result.then(result => { entry.expires = Date.now() + 60_000; return result; }, error => { cache.delete(key); throw error; });
  cache.set(key, entry);
  return entry.result;
}
