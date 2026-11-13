import type { ChatHistoryConfig } from "../config";
import { parseSessionId } from "../core/session-id";
import { deleteSessionEverywhere, hasArchivedData, previewSessionDeletion, type SessionDeletionPreview } from "../core/delete-session";
import { openIndex } from "../indexer/sqlite";
import { monitorStatePath } from "../monitor/state";

export type DeleteOutcome = "dry_run" | "deleted" | "already_deleted" | "aborted";

/** Irreversible: without dryRun it needs yes or an interactive confirm. */
export async function runDeleteCmd(opts: { cfg: ChatHistoryConfig; id: string; dryRun?: boolean; yes?: boolean; json?: boolean;
  write: (text: string) => void; confirm?: (prompt: string) => Promise<boolean> }): Promise<DeleteOutcome> {
  const parsed = parseSessionId(opts.id);
  if (!parsed.ok) throw new Error(parsed.error);
  const { source, sourceId } = parsed;
  const preview = previewSessionDeletion({ canonicalDir: opts.cfg.canonicalDir, indexPath: opts.cfg.indexPath }, source, sourceId);
  if (!hasArchivedData(preview)) {
    if (preview.tombstoned) { opts.write(opts.json ? JSON.stringify({ ...preview, outcome: "already_deleted" }, null, 2) : `${opts.id} is already deleted.`); return "already_deleted"; }
    // A tombstone blocks future capture, so a typo must not write one.
    throw new Error(`nothing archived for ${opts.id}; check the id with: chat-scrobbler list`);
  }
  if (opts.dryRun) {
    opts.write(opts.json ? JSON.stringify(preview, null, 2) : describe(preview).join("\n"));
    return "dry_run";
  }
  if (!opts.yes) {
    if (!opts.confirm) throw new Error("delete is irreversible; pass --yes to confirm, or --dry-run to preview");
    if (!await opts.confirm(`${describe(preview).join("\n")}\nDelete ${opts.id}? This cannot be undone. [y/N] `)) { opts.write("Aborted; nothing was deleted."); return "aborted"; }
  }
  const db = openIndex(opts.cfg.indexPath);
  let result: ReturnType<typeof deleteSessionEverywhere>;
  try {
    result = deleteSessionEverywhere({ canonicalDir: opts.cfg.canonicalDir, monitorStatePath: monitorStatePath(opts.cfg.indexPath, opts.cfg.monitorStatePath) }, db, source, sourceId);
  } finally { db.close(); }
  if (opts.json) opts.write(JSON.stringify({ id: opts.id, outcome: "deleted", ...result }, null, 2));
  else opts.write(`Deleted ${opts.id}: ${result.canonical.sessionDeleted ? "canonical file, " : ""}${preview.raw_versions} raw version(s), ${result.canonical.blobsDeleted} private blob(s)${result.index.deleted ? " and its index rows" : ""}. A tombstone keeps it from being captured again.`);
  return "deleted";
}

function describe(preview: SessionDeletionPreview): string[] {
  const { index } = preview;
  return [
    `Would delete ${preview.id}${preview.tombstoned ? " (already tombstoned; finishing an interrupted deletion)" : ""}:`,
    `  canonical file: ${preview.canonical_file ?? "(none)"}`,
    `  raw versions:   ${preview.raw_versions}`,
    `  private blobs:  ${preview.private_blobs ?? "unknown until asset ownership records are built"}${preview.private_blobs === null ? "" : " (blobs shared with other sessions are kept)"}`,
    `  index:          ${index.session ? 1 : 0} session row, ${index.messages} message(s), ${index.vectors} vector(s)`,
    `It also writes a tombstone so the session is not captured again.`,
  ];
}
