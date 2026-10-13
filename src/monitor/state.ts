import { assertStateOwner } from "./state-owner";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Source } from "../schema/types";

export function monitorStatePath(indexPath: string, override?: string | null): string {
  return override || `${indexPath}.monitor.sqlite`;
}

/** Separate from rebuildable index tables. Transactions also protect CLI acknowledgements. */
function withState<T>(path: string, fn: (db: Database) => T, dataDir?: string): T {
  assertStateOwner(path, dataDir);
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.run("PRAGMA busy_timeout = 0");
    db.run("PRAGMA journal_mode = WAL");
    db.run("CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, value INTEGER NOT NULL)");
    db.run("CREATE TABLE IF NOT EXISTS captures (source TEXT PRIMARY KEY, received_at TEXT NOT NULL)");
    db.run("CREATE TABLE IF NOT EXISTS acknowledged_types (type_id TEXT PRIMARY KEY)");
    db.run("CREATE TABLE IF NOT EXISTS asset_buckets (hour INTEGER PRIMARY KEY, count INTEGER NOT NULL)");
    return fn(db);
  } finally { db.close(); }
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

export function recordCaptureReceipt(path: string, source: Source, now = Date.now()): void {
  withState(path, db => db.run("INSERT INTO captures VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET received_at = max(received_at, excluded.received_at)", [source, new Date(now).toISOString()]));
}

export function acknowledgeTypes(path: string, typeIds: string[], dataDir?: string): void {
  withState(path, db => db.transaction(() => {
    for (const id of typeIds) db.run("INSERT OR IGNORE INTO acknowledged_types VALUES (?)", [id]);
  })(), dataDir);
}

export function readMonitorState(path: string, since = Date.now() - 48 * 3_600_000, dataDir?: string) {
  return withState(path, db => {
    const counters = Object.fromEntries((db.query("SELECT key, value FROM counters").all() as Array<{ key: string; value: number }>).map(row => [row.key, row.value]));
    const captures = Object.fromEntries((db.query("SELECT source, received_at FROM captures").all() as Array<{ source: Source; received_at: string }>).map(row => [row.source, row.received_at])) as Partial<Record<Source, string>>;
    const acknowledged = new Set((db.query("SELECT type_id FROM acknowledged_types").all() as Array<{ type_id: string }>).map(row => row.type_id));
    const recentAssets = (db.query("SELECT coalesce(sum(count), 0) AS count FROM asset_buckets WHERE hour >= ?").get(Math.floor(since / 3_600_000)) as { count: number }).count;
    return { counters, captures, acknowledged, recentAssets };
  }, dataDir);
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
