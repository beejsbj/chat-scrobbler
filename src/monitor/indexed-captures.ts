import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { Source } from "../schema/types";
import { SOURCES } from "../store/raw-catalog";

/** Bootstrap HTTP freshness from canonical metadata already projected into the index. */
export function indexedCaptureTimes(path?: string): Partial<Record<Source, string>> {
  const latest: Partial<Record<Source, string>> = {};
  if (!path || !existsSync(path)) return latest;
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    db.run("PRAGMA busy_timeout = 0");
    const rows = db.query("SELECT source, max(updated_at) AS time FROM sessions GROUP BY source").all() as Array<{ source: Source; time: string }>;
    for (const row of rows) {
      const time = Date.parse(row.time);
      if (SOURCES.includes(row.source) && Number.isFinite(time)) latest[row.source] = new Date(time).toISOString();
    }
  } catch { /* Index health is a deferred CLI check. */ }
  finally { db?.close(); }
  return latest;
}
