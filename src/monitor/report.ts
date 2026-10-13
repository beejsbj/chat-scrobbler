import { providerFreshness } from "./freshness";
import { parseFailureLines } from "./parse-state";
import { MonitorStateError, monitorDataDir } from "./state-owner";
import { monitorWriteFailed } from "./state-fault";
import { acknowledgeTypes, monitorStatePath, readMonitorState } from "./state";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { monitorHealth } from "./health";
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
  const dataDir = opts.canonicalDir ? monitorDataDir(opts.canonicalDir) : undefined;
  let state: ReturnType<typeof readMonitorState> | null = null;
  try { if (statePath) state = readMonitorState(statePath, since, dataDir); else fail("state", "not_configured"); }
  catch (error) { fail("state", error instanceof MonitorStateError ? error.reason : "unavailable"); }
  if (statePath && monitorWriteFailed(statePath)) fail("state", "write_failed");
  const indexExists = opts.indexPath && existsSync(opts.indexPath);
  const health = await monitorHealth(opts);
  for (const store of ["index", "canonical", "raw", "assets"] as const) {
    if (!health[store].ok) fail(`store.${store}`, health[store].reason ?? "unavailable");
  }
  if (health.semantic !== "available") fail("semantic", health.semantic === "disabled" ? "disabled" : "unavailable");
  const canonicalDir = opts.canonicalDir ?? "";
  const rawDir = opts.rawDir ?? (canonicalDir ? rawDirForCanonicalDir(canonicalDir) : "");
  let raw = { lastCapture: { chatgpt: null, claude: null, gemini: null } as Record<typeof SOURCES[number], string | null>, parseFailures: 0, unprojected: 0, unreadable: 0 };
  try { if (canonicalDir && rawDir) raw = rawObservations(rawDir, canonicalDir); }
  catch { fail("raw", "scan_failed"); }
  const receipts = Object.fromEntries(SOURCES.map(source => [source, [raw.lastCapture[source], state?.captures[source]].filter((time): time is string => !!time).sort().at(-1) ?? null]));
  const freshness = providerFreshness(settings.monitorStaleDays, receipts, state?.parsed ?? {}, state !== null);
  const providers = freshness.providers;
  failures.push(...freshness.failures, ...parseFailureLines(state));
  if (raw.parseFailures) fail("parse", `failed_versions_without_canonical=${raw.parseFailures}`);
  if (raw.unprojected) fail("canonical", `unprojected_raw_versions=${raw.unprojected}`);
  if (raw.unreadable) fail("raw", `unreadable_versions=${raw.unreadable}`);
  let unknown: ReturnType<typeof unknownTypes> = { counts: [], unreadable_sessions: 0, scanned_sessions: 0 };
  try { if (canonicalDir) unknown = unknownTypes(canonicalDir); }
  catch { fail("canonical", "scan_failed"); }
  const types = unknown.counts.map(row => ({ source: row.source, type_id: unknownTypeId(row.source, row.provider_type), count: row.count }));
  if (ack && statePath && state) {
    try {
      acknowledgeTypes(statePath, types.map(type => type.type_id), dataDir);
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
  return { ok: failures.length === 0, failures, providers, unknown_types: types.map(type => ({ ...type, acknowledged: state?.acknowledged.has(type.type_id) ?? false })), embeddings: { semantic: noVectors ? "unavailable" : health.semantic, coverage }, assets: { missing_recent_blocks: missingAssets, upload_failures: state?.counters.asset_failures ?? 0, recent_upload_failures: state?.recentAssets ?? 0 }, parse: { ...state?.parse, failed_versions_without_canonical: raw.parseFailures }, counters: state?.counters ?? {}, health };
}
