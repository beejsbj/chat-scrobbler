// src/core/delete-session.ts
// Erases one session everywhere a capture leaves it. Shared by DELETE /captures and
// the CLI so both remove the same things.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { deleteIndexedSession } from "../indexer/sqlite";
import { clearSessionAssetOutcomes } from "../monitor/state";
import { monitorWrite } from "../monitor/state-fault";
import { assetsDirForSession } from "../store/assets";
import { deleteSessionArchive, hasPendingBlobCleanup, privateBlobCount } from "../store/delete";
import { listRawCaptures, rawDirForCanonicalDir } from "../store/raw";
import { sessionFilePath } from "../store/sessions";
import { isSessionDeleted, SessionDeletedError } from "../store/tombstones";

export { SessionDeletedError };

export interface SessionDeletionPaths { canonicalDir: string; rawDir?: string; monitorStatePath: string }

/** Archive first (it writes the tombstone), then the derived index and monitor rows. */
export function deleteSessionEverywhere(paths: SessionDeletionPaths, db: Database, source: string, sourceId: string, extraCandidates?: Set<string>) {
  const canonical = deleteSessionArchive(paths.canonicalDir, source, sourceId, paths.rawDir, extraCandidates);
  const index = deleteIndexedSession(db, source, sourceId);
  monitorWrite(paths.monitorStatePath, () => clearSessionAssetOutcomes(paths.monitorStatePath, source, sourceId));
  return { canonical, index };
}

/** Ingest checks the tombstone before it writes, but `chat-scrobbler delete` runs in
 *  another process and can write it in between. Deletion writes the tombstone before it
 *  erases anything, so a second check after the write closes that gap: absent now, any
 *  later deletion starts after this write and erases it; present, erase again here.
 *  `written` names blobs the write may have added: a deletion that collected its
 *  candidates first and removed owner records after would otherwise orphan them.
 *  Erasure is idempotent, so it may run beside the CLI's. Never touches another session. */
export function eraseIfDeletedMeanwhile(paths: { canonicalDir: string; rawDir?: string; monitorStatePath?: string }, db: Database | null, source: string, sourceId: string, written?: Set<string>): boolean {
  if (!isSessionDeleted(paths.canonicalDir, source, sourceId)) return false;
  if (db && paths.monitorStatePath) deleteSessionEverywhere({ ...paths, monitorStatePath: paths.monitorStatePath }, db, source, sourceId, written);
  else deleteSessionArchive(paths.canonicalDir, source, sourceId, paths.rawDir, written);
  return true;
}

/** Run one session-scoped write; if the session was deleted meanwhile, erase what it
 *  wrote and throw SessionDeletedError instead of returning or rethrowing. */
export function writeUnlessDeleted<T>(paths: { canonicalDir: string; rawDir?: string; monitorStatePath?: string }, db: Database | null, source: string, sourceId: string, write: () => T, written?: Set<string>): T {
  let result: T;
  try { result = write(); }
  catch (error) {
    if (eraseIfDeletedMeanwhile(paths, db, source, sourceId, written)) throw new SessionDeletedError();
    throw error;
  }
  if (eraseIfDeletedMeanwhile(paths, db, source, sourceId, written)) throw new SessionDeletedError();
  return result;
}

export interface SessionDeletionPreview {
  id: string;
  tombstoned: boolean;
  canonical_file: string | null;
  raw_versions: number;
  /** Null when it cannot be known without building ownership records. */
  private_blobs: number | null;
  session_assets: boolean;
  /** An earlier deletion stopped before collecting its blobs. */
  pending_blob_cleanup: boolean;
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
    pending_blob_cleanup: hasPendingBlobCleanup(paths.canonicalDir, source, sourceId),
    index: indexedRows(paths.indexPath, `${source}:${sourceId}`),
  };
}

export function hasArchivedData(preview: SessionDeletionPreview): boolean {
  return !!preview.canonical_file || preview.raw_versions > 0 || preview.session_assets || preview.pending_blob_cleanup || preview.index.session;
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
