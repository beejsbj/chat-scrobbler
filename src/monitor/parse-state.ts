import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { Source } from "../schema/types";
import { SOURCES } from "../store/raw-catalog";
import { withState } from "./state-db";

export function recordParseOutcome(path: string, source: Source, sourceId: string, success: boolean, now = Date.now()): void {
  // Opaque IDs also keep arbitrary provider identifiers out of operational state/output.
  const sessionId = `${source}:${createHash("sha256").update(sourceId).digest("hex").slice(0, 16)}`;
  withState(path, db => db.transaction(() => {
    if (success) {
      db.run("INSERT INTO parsed_captures VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET parsed_at = max(parsed_at, excluded.parsed_at)", [source, new Date(now).toISOString()]);
      db.run("DELETE FROM failed_sessions WHERE source = ? AND session_id = ?", [source, sessionId]);
    } else {
      db.run("INSERT INTO counters VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET value = value + 1", [`parse_${source}_failures`]);
      db.run("INSERT INTO failed_sessions VALUES (?, ?, ?) ON CONFLICT(source, session_id) DO UPDATE SET failed_at = excluded.failed_at", [source, sessionId, now]);
    }
  })());
}

export function emptyParseState() {
  const parse = Object.fromEntries(SOURCES.map(source => [source, { total_failures: 0, recent_failed_sessions: 0, session_ids: [] as string[] }])) as Record<Source, { total_failures: number; recent_failed_sessions: number; session_ids: string[] }>;
  return { parsed: {} as Partial<Record<Source, string>>, parse };
}

export function readParseState(db: Database, since: number, counters: Record<string, number>) {
  const result = emptyParseState();
  const tables = new Set((db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(row => row.name));
  if (tables.has("parsed_captures")) {
    for (const row of db.query("SELECT source, parsed_at FROM parsed_captures").all() as Array<{ source: Source; parsed_at: string }>) result.parsed[row.source] = row.parsed_at;
  }
  for (const source of SOURCES) {
    result.parse[source].total_failures = counters[`parse_${source}_failures`] ?? 0;
    if (!tables.has("failed_sessions")) continue;
    const recent = db.query("SELECT count(*) AS count FROM failed_sessions WHERE source = ? AND failed_at >= ?").get(source, since) as { count: number };
    result.parse[source].recent_failed_sessions = recent.count;
    result.parse[source].session_ids = (db.query("SELECT session_id FROM failed_sessions WHERE source = ? AND failed_at >= ? ORDER BY session_id LIMIT 20").all(source, since) as Array<{ session_id: string }>).map(row => row.session_id);
  }
  return result;
}

export function parseFailureLines(state: ReturnType<typeof emptyParseState> | null): string[] {
  return SOURCES.filter(source => state?.parse[source].recent_failed_sessions).map(source => `FAILED parse.${source} recent_failed_sessions=${state!.parse[source].recent_failed_sessions}`);
}
