import { existsSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { sanitizePathSegment } from "../../packages/shared/src";
import { assetBlobPath, assetsDirForCanonicalDir, assetsDirForSession } from "./assets";
import { captureHashes, collectAssetHashes, filesUnder, unreferencedAssetHashes } from "./asset-references";
import { hasOtherAssetOwners, ownedAssetHashes, referenceStoreReady, removeAssetOwner } from "./asset-reference-store";
import { deleteSession, sessionFilePath } from "./sessions";
import { rawDirForCanonicalDir } from "./raw";
import { encodedSegment, markSessionDeleted } from "./tombstones";
import { syncDirectory, writeAtomicFile } from "./atomic-file";

type SessionIdentity = { source: string; source_id: string };
export function deleteSessionArchive(canonicalDir: string, source: string, sourceId: string, rawDir = rawDirForCanonicalDir(canonicalDir)) {
  const result = deleteSessionArchives(canonicalDir, [{ source, source_id: sourceId }], rawDir);
  return { ...result.sessions[0], blobsDeleted: result.blobsDeleted, blobCleanupPending: result.blobCleanupPending };
}

// Blob candidates outlive the references they were found through, so a deletion
// interrupted before blob collection (crash, error, deferral) can still finish.
export const pendingBlobCleanupDir = (canonicalDir: string) => join(canonicalDir, ".pending-blob-cleanup");
const pendingCleanupPath = (canonicalDir: string, source: string, id: string) =>
  join(pendingBlobCleanupDir(canonicalDir), encodedSegment(source), `${encodedSegment(id)}.json`);
export function hasPendingBlobCleanup(canonicalDir: string, source: string, id: string): boolean {
  return existsSync(pendingCleanupPath(canonicalDir, source, id));
}
export function countPendingBlobCleanup(canonicalDir: string): number {
  return filesUnder(pendingBlobCleanupDir(canonicalDir), "*/*.json").length;
}
/** Restore merges backed-up records so a restored store can still finish that cleanup. */
export function restorePendingBlobCleanup(canonicalDir: string, source: string, id: string, hashes: unknown): void {
  sessionFilePath(canonicalDir, source, id);
  if (!Array.isArray(hashes) || hashes.some(hash => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))) throw new Error("invalid pending blob cleanup record");
  const merged = new Set<string>(hashes);
  readPendingBlobCleanup(canonicalDir, source, id, merged);
  writeAtomicFile(pendingCleanupPath(canonicalDir, source, id), JSON.stringify([...merged]));
}
function readPendingBlobCleanup(canonicalDir: string, source: string, id: string, into: Set<string>): void {
  const file = pendingCleanupPath(canonicalDir, source, id);
  if (!existsSync(file)) return;
  const hashes = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(hashes) || hashes.some(hash => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))) throw new Error("invalid pending blob cleanup record");
  for (const hash of hashes) into.add(hash);
}

/** Restore erases all tombstoned files before one shared blob-ownership check.
 *  deferBlobCleanup skips that check when the store may be missing live references. */
export function deleteSessionArchives(canonicalDir: string, identities: SessionIdentity[], rawDir = rawDirForCanonicalDir(canonicalDir), options: { deferBlobCleanup?: boolean } = {}) {
  const assetsDir = assetsDirForCanonicalDir(canonicalDir);
  const candidates = new Set<string>();
  let collectionFailed = false;
  const collect = (step: () => void) => { try { step(); } catch { collectionFailed = true; } };
  for (const { source, source_id } of identities) {
    sessionFilePath(canonicalDir, source, source_id);
    markSessionDeleted(canonicalDir, { source, source_id, deleted_at: new Date().toISOString() });
  }
  const legacyMetadata: any[] | undefined = referenceStoreReady(assetsDir) ? undefined : [];
  const legacyCandidates = new Map<string, Set<string>>();
  // Older uploads may have only first_seen metadata. Examine that namespace once per operation.
  if (identities.length && !referenceStoreReady(assetsDir)) collect(() => {
    const deletedIds = new Set(identities.map(id => `${id.source}:${id.source_id}`));
    for (const file of filesUnder(join(assetsDir, "sha256"), "**/*.json")) collect(() => {
      const metadata = JSON.parse(readFileSync(file, "utf8"));
      legacyMetadata!.push(metadata);
      const owner = metadata.first_seen?.session_id;
      if (!deletedIds.has(owner)) return;
      if (!legacyCandidates.has(owner)) legacyCandidates.set(owner, new Set());
      collectAssetHashes(metadata.sha256, legacyCandidates.get(owner)!);
    });
  });
  const sessions = identities.map(({ source, source_id: sourceId }) => {
    const sessionPath = sessionFilePath(canonicalDir, source, sourceId);
    const rawSessionDir = join(rawDir, encodedSegment(source), encodedSegment(sourceId));
    const owned = new Set(legacyCandidates.get(`${source}:${sourceId}`));
    collect(() => readPendingBlobCleanup(canonicalDir, source, sourceId, owned));
    collect(() => { if (existsSync(sessionPath)) captureHashes(sessionPath, owned); });
    collect(() => { for (const file of filesUnder(rawSessionDir, "*.json.gz")) collect(() => captureHashes(file, owned)); });
    collect(() => { for (const file of filesUnder(assetsDirForSession(canonicalDir, source, sourceId))) collectAssetHashes(basename(file), owned); });
    for (const root of [canonicalDir, rawDir, assetsDir]) collect(() => { for (const hash of ownedAssetHashes(root, source, sourceId)) owned.add(hash); });
    // Persist before erasing anything that points at these blobs.
    if (owned.size) writeAtomicFile(pendingCleanupPath(canonicalDir, source, sourceId), JSON.stringify([...owned]));
    for (const hash of owned) candidates.add(hash);
    const result = deleteSession(canonicalDir, source, sourceId);
    const rawDeleted = existsSync(rawSessionDir);
    if (rawDeleted) { rmSync(rawSessionDir, { recursive: true, force: true }); syncDirectory(dirname(rawSessionDir)); }
    for (const root of [canonicalDir, rawDir, assetsDir]) removeAssetOwner(root, source, sourceId, candidates);
    // Legacy upload aliases used sanitized IDs; their reference record tracks that directory.
    if (sanitizePathSegment(sourceId) !== sourceId) removeAssetOwner(assetsDir, source, sanitizePathSegment(sourceId), candidates);
    return { ...result, rawDeleted };
  });
  if (collectionFailed) console.error(JSON.stringify({ event: "asset_cleanup_deferred", reason: "unreadable_deleted_reference" }));
  else if (options.deferBlobCleanup && candidates.size) console.error(JSON.stringify({ event: "asset_cleanup_deferred", reason: "incomplete_restore" }));
  const unreferenced = collectionFailed || options.deferBlobCleanup || !candidates.size ? null : unreferencedAssetHashes(canonicalDir, rawDir, candidates, legacyMetadata);
  let blobsDeleted = 0;
  if (unreferenced) for (const hash of unreferenced) {
    const blob = assetBlobPath(canonicalDir, hash);
    // force: ingest may erase the same session at the same moment (eraseIfDeletedMeanwhile).
    if (existsSync(blob)) { rmSync(blob, { force: true }); blobsDeleted++; }
    if (existsSync(`${blob}.json`)) rmSync(`${blob}.json`, { force: true });
    if (existsSync(dirname(blob))) syncDirectory(dirname(blob));
  }
  const blobCleanupPending = collectionFailed || !!options.deferBlobCleanup || (candidates.size > 0 && !unreferenced);
  if (!blobCleanupPending) for (const { source, source_id } of identities) {
    const file = pendingCleanupPath(canonicalDir, source, source_id);
    if (existsSync(file)) { rmSync(file, { force: true }); syncDirectory(dirname(file)); }
  }
  return { sessions, blobsDeleted, blobCleanupPending };
}

/** Read-only count of blobs deleting this session would erase. Null while ownership
 *  records are not built (deletion builds them) or a reference cannot be read. */
export function privateBlobCount(canonicalDir: string, source: string, sourceId: string, rawDir = rawDirForCanonicalDir(canonicalDir)): number | null {
  const roots = [canonicalDir, rawDir, assetsDirForCanonicalDir(canonicalDir)];
  if (!roots.every(referenceStoreReady)) return null;
  const candidates = new Set<string>();
  try {
    readPendingBlobCleanup(canonicalDir, source, sourceId, candidates);
    const sessionPath = sessionFilePath(canonicalDir, source, sourceId);
    if (existsSync(sessionPath)) captureHashes(sessionPath, candidates);
    for (const file of filesUnder(join(rawDir, encodedSegment(source), encodedSegment(sourceId)), "*.json.gz")) captureHashes(file, candidates);
    for (const file of filesUnder(assetsDirForSession(canonicalDir, source, sourceId))) collectAssetHashes(basename(file), candidates);
    for (const root of roots) for (const hash of ownedAssetHashes(root, source, sourceId)) candidates.add(hash);
    return [...candidates].filter(hash => existsSync(assetBlobPath(canonicalDir, hash))
      && !roots.some(root => hasOtherAssetOwners(root, hash, source, sourceId))).length;
  } catch { return null; }
}
