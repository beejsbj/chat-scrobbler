import { readFileSync } from "node:fs";
import { writeAtomicFile } from "../../../src/store/atomic-file";
import { MAX_CAPTURE_ATTEMPTS, type ConversationCaptureFailure } from "../../shared/src";

/** Provider snapshots are durable, so a server restart does not hide quarantined conversations. */
export function captureFailureReports(indexPath: string, source: string, value?: unknown): ConversationCaptureFailure[] {
  const path = `${indexPath}.capture-failures.json`;
  let reports: Record<string, ConversationCaptureFailure[]> = {};
  try { reports = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (value !== undefined) {
    if (!Array.isArray(value) || value.length > 5000) throw new Error("capture_failures must be an array of at most 5000 records");
    reports[source] = value.map(f => {
      if (!f || typeof f.source_id !== "string" || !f.source_id || f.source_id.length > 200
        || !Number.isSafeInteger(f.attempts) || f.attempts < 1
        || (f.updated_at !== null && typeof f.updated_at !== "string")
        || typeof f.quarantined !== "boolean" || f.quarantined !== (f.attempts >= MAX_CAPTURE_ATTEMPTS)) throw new Error("invalid capture failure record");
      if (f.retry_after !== undefined && (typeof f.retry_after !== "string" || !Number.isFinite(Date.parse(f.retry_after)))) throw new Error("invalid capture retry timestamp");
      return { source_id: f.source_id, updated_at: f.updated_at, attempts: f.attempts, quarantined: f.quarantined, ...(f.retry_after ? { retry_after: f.retry_after } : {}) };
    });
    writeAtomicFile(path, JSON.stringify(reports));
  }
  return reports[source] ?? [];
}
