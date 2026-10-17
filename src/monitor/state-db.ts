import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { assertStateOwner } from "./state-owner";

/** Separate from rebuildable index tables. Transactions also protect CLI acknowledgements. */
export function withState<T>(path: string, fn: (db: Database) => T, dataDir?: string): T {
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
    db.run("CREATE TABLE IF NOT EXISTS parsed_captures (source TEXT PRIMARY KEY, parsed_at TEXT NOT NULL)");
    db.run("CREATE TABLE IF NOT EXISTS failed_sessions (source TEXT, session_id TEXT, failed_at INTEGER, PRIMARY KEY(source, session_id))");
    db.run("CREATE INDEX IF NOT EXISTS failed_sessions_recent ON failed_sessions(source, failed_at)");
    // One row per asset identity; attempts accumulate while the reason reflects the latest report.
    db.run("CREATE TABLE IF NOT EXISTS asset_outcomes (source TEXT NOT NULL, source_id TEXT NOT NULL, message_id TEXT NOT NULL, pointer TEXT NOT NULL, reason TEXT NOT NULL, terminal INTEGER NOT NULL, attempts INTEGER NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, PRIMARY KEY(source, source_id, message_id, pointer))");
    db.run("CREATE INDEX IF NOT EXISTS asset_outcomes_recent ON asset_outcomes(last_seen)");
    return fn(db);
  } finally { db.close(); }
}

