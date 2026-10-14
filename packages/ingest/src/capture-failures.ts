import { readFileSync } from "node:fs";
import { writeAtomicFile } from "../../../src/store/atomic-file";
import { MAX_CAPTURE_ATTEMPTS, type ConversationCaptureFailure } from "../../shared/src";

export const LEGACY_INSTALL_KEY = "legacy";
const SAFE_INSTALL_ID = /^[A-Za-z0-9_-]{1,128}$/;

function aggregateReports(snapshots: Record<string, ConversationCaptureFailure[]>): ConversationCaptureFailure[] {
  const merged = new Map<string, ConversationCaptureFailure>();
  for (const list of Object.values(snapshots)) {
    for (const item of list) {
      const existing = merged.get(item.source_id);
      if (!existing) {
        merged.set(item.source_id, { ...item });
      } else {
        const attempts = Math.max(existing.attempts, item.attempts);
        const quarantined = existing.quarantined || item.quarantined;
        const retry_after = [existing.retry_after, item.retry_after].filter((s): s is string => typeof s === "string").sort().at(-1);
        merged.set(item.source_id, {
          ...existing,
          ...item,
          attempts,
          quarantined,
          updated_at: item.updated_at ?? existing.updated_at,
          ...(retry_after ? { retry_after } : {}),
        });
      }
    }
  }
  return [...merged.values()];
}

/** Provider snapshots are durable and partitioned by browser install. */
export function captureFailureReports(indexPath: string, source: string, value?: unknown, installId?: unknown): ConversationCaptureFailure[] {
  if (installId !== undefined && (typeof installId !== "string" || !SAFE_INSTALL_ID.test(installId))) {
    throw new Error("invalid install_id");
  }
  const path = `${indexPath}.capture-failures.json`;
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }

  const reports: Record<string, Record<string, ConversationCaptureFailure[]>> = {};
  let migrated = false;
  for (const [s, content] of Object.entries(raw)) {
    if (Array.isArray(content)) {
      reports[s] = Object.assign(Object.create(null), { [LEGACY_INSTALL_KEY]: content });
      migrated = true;
    } else if (content && typeof content === "object") {
      reports[s] = Object.assign(Object.create(null), content) as Record<string, ConversationCaptureFailure[]>;
    }
  }

  if (value !== undefined) {
    if (!Array.isArray(value) || value.length > 5000) throw new Error("capture_failures must be an array of at most 5000 records");
    const installKey = (installId as string | undefined) ?? LEGACY_INSTALL_KEY;
    reports[source] ??= Object.create(null);
    reports[source][installKey] = value.map(f => {
      if (!f || typeof f.source_id !== "string" || !f.source_id || f.source_id.length > 200
        || !Number.isSafeInteger(f.attempts) || f.attempts < 1
        || (f.updated_at !== null && typeof f.updated_at !== "string")
        || typeof f.quarantined !== "boolean" || f.quarantined !== (f.attempts >= MAX_CAPTURE_ATTEMPTS)) throw new Error("invalid capture failure record");
      if (f.retry_after !== undefined && (typeof f.retry_after !== "string" || !Number.isFinite(Date.parse(f.retry_after)))) throw new Error("invalid capture retry timestamp");
      return { ...f, source_id: f.source_id, updated_at: f.updated_at, attempts: f.attempts, quarantined: f.quarantined, ...(f.retry_after ? { retry_after: f.retry_after } : {}) };
    });
    writeAtomicFile(path, JSON.stringify(reports));
  } else if (migrated) {
    writeAtomicFile(path, JSON.stringify(reports));
  }

  if (installId !== undefined) {
    return reports[source]?.[installId as string] ?? [];
  }
  return aggregateReports(reports[source] ?? {});
}
