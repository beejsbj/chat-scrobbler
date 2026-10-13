import { readFileSync } from "node:fs";
import { writeAtomicFile } from "../../../src/store/atomic-file";
import type { SyncIssue } from "../../shared/src";

function issue(value: unknown): SyncIssue {
  const v = value as SyncIssue;
  if (!v || !["receiver_unavailable", "provider_detail_outage", "sync_unavailable"].includes(v.reason)
    || typeof v.occurred_at !== "string" || !Number.isFinite(Date.parse(v.occurred_at))
    || v.status !== undefined && (!Number.isInteger(v.status) || v.status < 100 || v.status > 599)) throw new Error("invalid sync issue");
  return { reason: v.reason, occurred_at: v.occurred_at, ...(v.status === undefined ? {} : { status: v.status }) };
}

/** Last categorical sync error per provider/install, separate from counted chat failures. */
export function syncIssueReports(indexPath: string, source: string, value?: unknown, installId?: unknown): Array<SyncIssue & { install_id: string }> {
  if (installId !== undefined && (typeof installId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(installId))) throw new Error("invalid install_id");
  const path = `${indexPath}.sync-errors.json`;
  let saved: Record<string, Record<string, SyncIssue>> = {};
  try { saved = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const reports: Record<string, Record<string, SyncIssue>> = Object.assign(Object.create(null), saved);
  const installs: Record<string, SyncIssue> = Object.assign(Object.create(null), reports[source] ?? {});
  if (value !== undefined) {
    installs[(installId as string | undefined) ?? "legacy"] = issue(value);
    reports[source] = installs;
    writeAtomicFile(path, JSON.stringify(reports));
  }
  return Object.entries(installs).filter(([id]) => installId === undefined || id === installId).map(([id, v]) => ({ ...issue(v), install_id: id }));
}
