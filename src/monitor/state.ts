import { withState } from "./state-db";
import { ignoreKey } from "./asset-ignores";
import { emptyParseState, readParseState } from "./parse-state";
import { assertStateOwner } from "./state-owner";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Source } from "../schema/types";
import { isTerminalAssetFailure, MAX_ASSET_FAILURE_POINTER_CHARS } from "../../packages/shared/src/asset-failure";

/** A failure record nobody has reported for this long is not being retried; a later report recreates it. */
export const ASSET_OUTCOME_RETENTION_MS = 30 * 24 * 3_600_000;

export interface AssetFailureRecord { source_id: string; message_id: string | null; reason: string; pointer?: string | null; }
export interface AssetOutcomeIdentity { source: string; source_id: string; message_id: string | null; pointer: string; }
/** `ignored` counts assets the owner stopped retries for; they are in neither transient nor terminal. */
export interface AssetOutcomeSummary { transient: number; terminal: number; ignored: number; byReason: Record<string, number>; }
const emptyAssetOutcomes = (): AssetOutcomeSummary => ({ transient: 0, terminal: 0, ignored: 0, byReason: {} });

export function monitorStatePath(indexPath: string, override?: string | null): string {
  return override || `${indexPath}.monitor.sqlite`;
}


export function incrementMonitorCounter(path: string, key: "asset_failures" | "embedding_ingest_failures" | "embedding_mcp_failures", count = 1, now = Date.now()): void {
  if (!count) return;
  withState(path, db => db.transaction(() => {
    db.run("INSERT INTO counters VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = value + excluded.value", [key, count]);
    if (key === "asset_failures") {
      const hour = Math.floor(now / 3_600_000);
      db.run("INSERT INTO asset_buckets VALUES (?, ?) ON CONFLICT(hour) DO UPDATE SET count = count + excluded.count", [hour, count]);
      // Retain sparse hourly buckets so tuning the recent window does not lose events.
    }
  })());
}

/**
 * Counts every report (attempt history) and upserts one row per asset identity. Assets the owner
 * ignored are not counted or recorded; their pointers come back so the extension can stop retrying.
 * Every report also prunes records last seen over ASSET_OUTCOME_RETENTION_MS ago (never asset_ignores).
 */
export function recordAssetFailureOutcomes(path: string, source: string, failures: AssetFailureRecord[], now = Date.now()): string[] {
  if (!failures.length) return [];
  return withState(path, db => db.transaction(() => {
    const ignoredRows = db.query("SELECT source_id, message_id, pointer FROM asset_ignores WHERE source = ?").all(source) as Array<{ source_id: string; message_id: string; pointer: string }>;
    const ignored = new Set(ignoredRows.map(row => ignoreKey(row.source_id, row.message_id, row.pointer)));
    const isIgnored = (failure: AssetFailureRecord) => !!failure.pointer && ignored.has(ignoreKey(failure.source_id, failure.message_id, failure.pointer));
    const ignoredPointers = failures.filter(isIgnored).map(failure => failure.pointer!);
    failures = failures.filter(failure => !isIgnored(failure));
    // After the upserts, so a record being re-reported now keeps its attempts.
    const prune = () => db.run("DELETE FROM asset_outcomes WHERE last_seen < ?", [now - ASSET_OUTCOME_RETENTION_MS]);
    if (!failures.length) { prune(); return ignoredPointers; }
    db.run("INSERT INTO counters VALUES ('asset_failures', ?) ON CONFLICT(key) DO UPDATE SET value = value + excluded.value", [failures.length]);
    db.run("INSERT INTO asset_buckets VALUES (?, ?) ON CONFLICT(hour) DO UPDATE SET count = count + excluded.count", [Math.floor(now / 3_600_000), failures.length]);
    for (const failure of failures) {
      db.run(`INSERT INTO asset_outcomes VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(source, source_id, message_id, pointer) DO UPDATE SET reason = excluded.reason, terminal = excluded.terminal, attempts = attempts + 1, last_seen = excluded.last_seen`,
        [source, failure.source_id, failure.message_id ?? "", failure.pointer ?? "", failure.reason, isTerminalAssetFailure(failure.reason) ? 1 : 0, now, now]);
    }
    prune();
    return ignoredPointers;
  })());
}

/** Explicit session deletion leaves only the tombstone, so its asset failure records go too. */
export function clearSessionAssetOutcomes(path: string, source: string, sourceId: string): void {
  if (!existsSync(path)) return;
  withState(path, db => db.run("DELETE FROM asset_outcomes WHERE source = ? AND source_id = ?", [source, sourceId]));
}

/** A stored blob or reference for the same identity ends its failure record. */
export function clearAssetOutcome(path: string, identity: AssetOutcomeIdentity): void {
  if (!existsSync(path)) return;
  // The extension reports pointers past MAX_ASSET_FAILURE_POINTER_CHARS as `sha256:<hex>`; clear that form too.
  const pointers = identity.pointer.length > MAX_ASSET_FAILURE_POINTER_CHARS
    ? [identity.pointer, `sha256:${createHash("sha256").update(identity.pointer).digest("hex")}`]
    : [identity.pointer];
  withState(path, db => {
    for (const pointer of pointers) db.run("DELETE FROM asset_outcomes WHERE source = ? AND source_id = ? AND message_id = ? AND pointer = ?",
      [identity.source, identity.source_id, identity.message_id ?? "", pointer]);
  });
}

export function recordCaptureReceipt(path: string, source: Source, now = Date.now()): void {
  withState(path, db => db.run("INSERT INTO captures VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET received_at = max(received_at, excluded.received_at)", [source, new Date(now).toISOString()]));
}

export function acknowledgeTypes(path: string, typeIds: string[], dataDir?: string): void {
  withState(path, db => db.transaction(() => {
    for (const id of typeIds) db.run("INSERT OR IGNORE INTO acknowledged_types VALUES (?)", [id]);
  })(), dataDir);
}

export function readMonitorState(path: string, since = Date.now() - 48 * 3_600_000, dataDir?: string, includeAcknowledgements = true) {
  assertStateOwner(path, dataDir);
  if (!existsSync(path)) return { counters: {} as Record<string, number>, captures: {} as Partial<Record<Source, string>>, acknowledged: new Set<string>(), recentAssetReports: 0, assetOutcomes: emptyAssetOutcomes(), ...emptyParseState() };
  const db = new Database(path, { readonly: true });
  try {
    db.run("PRAGMA busy_timeout = 0");
    const counters = Object.fromEntries((db.query("SELECT key, value FROM counters").all() as Array<{ key: string; value: number }>).map(row => [row.key, row.value]));
    const captures = Object.fromEntries((db.query("SELECT source, received_at FROM captures").all() as Array<{ source: Source; received_at: string }>).map(row => [row.source, row.received_at])) as Partial<Record<Source, string>>;
    const acknowledged = new Set(includeAcknowledgements ? (db.query("SELECT type_id FROM acknowledged_types").all() as Array<{ type_id: string }>).map(row => row.type_id) : []);
    const recentAssetReports = (db.query("SELECT coalesce(sum(count), 0) AS count FROM asset_buckets WHERE hour >= ?").get(Math.floor(since / 3_600_000)) as { count: number }).count;
    return { counters, captures, acknowledged, recentAssetReports, assetOutcomes: readAssetOutcomes(db, since), ...readParseState(db, since, counters) };
  } finally { db.close(); }
}

/** No creation or schema writes while reporting an existing provider counter. */
export function readMonitorCounter(path: string, key: string): number {
  if (!existsSync(path)) return 0;
  const db = new Database(path, { readonly: true });
  try {
    db.run("PRAGMA busy_timeout = 0");
    const row = db.query("SELECT value FROM counters WHERE key = ?").get(key) as { value: number } | null;
    return row?.value ?? 0;
  } finally { db.close(); }
}

/** Distinct assets whose latest failure fell in the window, split by whether retrying can help. */
function readAssetOutcomes(db: Database, since: number): AssetOutcomeSummary {
  const summary = emptyAssetOutcomes();
  const exists = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'asset_outcomes'").get();
  if (!exists) return summary;
  for (const row of db.query("SELECT reason, terminal, count(*) AS count FROM asset_outcomes WHERE last_seen >= ? GROUP BY reason, terminal").all(since) as Array<{ reason: string; terminal: number; count: number }>) {
    summary.byReason[row.reason] = (summary.byReason[row.reason] ?? 0) + row.count;
    if (row.terminal) summary.terminal += row.count; else summary.transient += row.count;
  }
  if (db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'asset_ignores'").get()) {
    summary.ignored = (db.query("SELECT count(*) AS count FROM asset_ignores").get() as { count: number }).count;
  }
  return summary;
}
