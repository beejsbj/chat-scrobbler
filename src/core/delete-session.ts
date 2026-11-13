// src/core/delete-session.ts
// Erases one session everywhere a capture leaves it. Shared by DELETE /captures and
// the CLI so both remove the same things.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { deleteIndexedSession } from "../indexer/sqlite";
import { clearSessionAssetOutcomes } from "../monitor/state";
import { monitorWrite } from "../monitor/state-fault";
import { assetsDirForSession } from "../store/assets";
import { deleteSessionArchive, privateBlobCount } from "../store/delete";
import { listRawCaptures, rawDirForCanonicalDir } from "../store/raw";
import { sessionFilePath } from "../store/sessions";
import { isSessionDeleted } from "../store/tombstones";

export interface SessionDeletionPaths { canonicalDir: string; rawDir?: string; monitorStatePath: string }

/** Archive first (it writes the tombstone), then the derived index and monitor rows. */
export function deleteSessionEverywhere(paths: SessionDeletionPaths, db: Database, source: string, sourceId: string) {
  const canonical = deleteSessionArchive(paths.canonicalDir, source, sourceId, paths.rawDir);
  const index = deleteIndexedSession(db, source, sourceId);
  monitorWrite(paths.monitorStatePath, () => clearSessionAssetOutcomes(paths.monitorStatePath, source, sourceId));
  return { canonical, index };
}

export interface SessionDeletionPreview {
  id: string;
  tombstoned: boolean;
  canonical_file: string | null;
  raw_versions: number;
  /** Null when it cannot be known without building ownership records. */
  private_blobs: number | null;
  session_assets: boolean;
  index: { session: boolean; messages: number; vectors: number };
}

/** Read-only: what deleteSessionEverywhere would remove. Opens the index read-only. */
export function previewSessionDeletion(paths: { canonicalDir: string; rawDir?: string; indexPath: string }, source: string, sourceId: string): SessionDeletionPreview {
  const rawDir = paths.rawDir ?? rawDirForCanonicalDir(paths.canonicalDir);
  const file = sessionFilePath(paths.canonicalDir, source, sourceId);
  return {
    id: `${source}:${sourceId}`,
    tombstoned: isSessionDeleted(paths.canonicalDir, source, sourceId),
    canonical_file: existsSync(file) ? file : null,
    raw_versions: listRawCaptures(rawDir, source, sourceId).length,
    private_blobs: privateBlobCount(paths.canonicalDir, source, sourceId, rawDir),
    session_assets: existsSync(assetsDirForSession(paths.canonicalDir, source, sourceId)),
    index: indexedRows(paths.indexPath, `${source}:${sourceId}`),
  };
}

export function hasArchivedData(preview: SessionDeletionPreview): boolean {
  return !!preview.canonical_file || preview.raw_versions > 0 || preview.session_assets || preview.index.session;
}

function indexedRows(indexPath: string, id: string): SessionDeletionPreview["index"] {
  if (!existsSync(indexPath)) return { session: false, messages: 0, vectors: 0 };
  const db = new Database(indexPath, { readonly: true });
  try {
    const count = (sql: string) => (db.query(sql).get(id) as { n: number }).n;
    const tables = new Set((db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(row => row.name));
    const vectors = ["message_vectors", "message_vector_chunks", "message_embeddings"].filter(table => tables.has(table))
      .reduce((sum, table) => sum + count(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`), 0);
    return {
      session: tables.has("sessions") && count("SELECT COUNT(*) AS n FROM sessions WHERE id = ?") > 0,
      messages: tables.has("messages_fts") ? count("SELECT COUNT(*) AS n FROM messages_fts WHERE session_id = ?") : 0,
      vectors,
    };
  } finally { db.close(); }
}
