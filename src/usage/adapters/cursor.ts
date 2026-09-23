import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { UsageAccumulator, finiteNumber, isoDay } from "../aggregate";
import { findProjectPath, projectFromPath } from "../project";
import type { CollectResult } from "../types";

export interface CursorCollectOptions { databasePath: string; device: string }

export function collectCursorUsage(options: CursorCollectOptions): CollectResult {
  if (!existsSync(options.databasePath)) {
    return { buckets: [], coverage: [{ source: "cursor", status: "missing", detail: "Cursor state database was not found on this device", records: 0 }] };
  }
  const acc = new UsageAccumulator();
  let records = 0;
  const db = new Database(options.databasePath, { readonly: true });
  try {
    const rows = db.query("SELECT value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").all() as Array<{ value: string | Uint8Array }>;
    for (const row of rows) {
      try {
        const text = typeof row.value === "string" ? row.value : new TextDecoder().decode(row.value);
        const data = JSON.parse(text) as Record<string, any>;
        const path = findProjectPath(data.context) ?? findProjectPath(data.tabs) ?? findProjectPath(data.codeBlockData);
        const date = isoDay(data.createdAt ?? data.lastUpdatedAt);
        const conversation = Array.isArray(data.conversation) ? data.conversation : [];
        const model = typeof data.model === "string" ? data.model : "Unavailable";
        acc.add({
          date, source: "cursor", surface: "Cursor", device: options.device, project: projectFromPath(path), model,
          sessions: 1, messages: conversation.length,
        });
        records += 1;
      } catch { /* Keep the remaining composer records usable. */ }
    }
  } finally {
    db.close();
  }
  return {
    buckets: acc.list(),
    coverage: [{ source: "cursor", status: "count-only", detail: "Composer sessions and message counts; Cursor does not preserve authoritative billed token totals here", records }],
  };
}

