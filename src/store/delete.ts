import { existsSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { sanitizePathSegment } from "../../packages/shared/src";
import { assetBlobPath, assetsDirForCanonicalDir, assetsDirForSession } from "./assets";
import { captureHashes, collectAssetHashes, filesUnder, unreferencedAssetHashes } from "./asset-references";
import { ownedAssetHashes, referenceStoreReady, removeAssetOwner } from "./asset-reference-store";
import { deleteSession, sessionFilePath } from "./sessions";
import { rawDirForCanonicalDir } from "./raw";
import { encodedSegment, markSessionDeleted } from "./tombstones";
import { syncDirectory } from "./atomic-file";

type SessionIdentity = { source: string; source_id: string };
export function deleteSessionArchive(canonicalDir: string, source: string, sourceId: string, rawDir = rawDirForCanonicalDir(canonicalDir)) {
  const result = deleteSessionArchives(canonicalDir, [{ source, source_id: sourceId }], rawDir);
  return { ...result.sessions[0], blobsDeleted: result.blobsDeleted };
}

/** Restore erases all tombstoned files before one shared blob-ownership check. */
export function deleteSessionArchives(canonicalDir: string, identities: SessionIdentity[], rawDir = rawDirForCanonicalDir(canonicalDir)) {
  const assetsDir = assetsDirForCanonicalDir(canonicalDir);
  const candidates = new Set<string>();
  let collectionFailed = false;
  const collect = (step: () => void) => { try { step(); } catch { collectionFailed = true; } };
  for (const { source, source_id } of identities) {
    sessionFilePath(canonicalDir, source, source_id);
    markSessionDeleted(canonicalDir, { source, source_id, deleted_at: new Date().toISOString() });
  }
  const legacyMetadata: any[] | undefined = referenceStoreReady(assetsDir) ? undefined : [];
  // Older uploads may have only first_seen metadata. Examine that namespace once per operation.
  if (identities.length && !referenceStoreReady(assetsDir)) collect(() => {
    const deletedIds = new Set(identities.map(id => `${id.source}:${id.source_id}`));
    for (const file of filesUnder(join(assetsDir, "sha256"), "**/*.json")) collect(() => {
      const metadata = JSON.parse(readFileSync(file, "utf8"));
      legacyMetadata!.push(metadata);
      if (deletedIds.has(metadata.first_seen?.session_id)) collectAssetHashes(metadata.sha256, candidates);
    });
  });
  const sessions = identities.map(({ source, source_id: sourceId }) => {
    const sessionPath = sessionFilePath(canonicalDir, source, sourceId);
    const rawSessionDir = join(rawDir, encodedSegment(source), encodedSegment(sourceId));
    collect(() => { if (existsSync(sessionPath)) captureHashes(sessionPath, candidates); });
    collect(() => { for (const file of filesUnder(rawSessionDir, "*.json.gz")) collect(() => captureHashes(file, candidates)); });
    collect(() => { for (const file of filesUnder(assetsDirForSession(canonicalDir, source, sourceId))) collectAssetHashes(basename(file), candidates); });
    for (const root of [canonicalDir, rawDir, assetsDir]) collect(() => { for (const hash of ownedAssetHashes(root, source, sourceId)) candidates.add(hash); });
    const result = deleteSession(canonicalDir, source, sourceId);
    const rawDeleted = existsSync(rawSessionDir);
    if (rawDeleted) { rmSync(rawSessionDir, { recursive: true, force: true }); syncDirectory(dirname(rawSessionDir)); }
    for (const root of [canonicalDir, rawDir, assetsDir]) removeAssetOwner(root, source, sourceId, candidates);
    // Legacy upload aliases used sanitized IDs; their reference record tracks that directory.
    if (sanitizePathSegment(sourceId) !== sourceId) removeAssetOwner(assetsDir, source, sanitizePathSegment(sourceId), candidates);
    return { ...result, rawDeleted };
  });
  if (collectionFailed) console.error(JSON.stringify({ event: "asset_cleanup_deferred", reason: "unreadable_deleted_reference" }));
  const unreferenced = collectionFailed || !candidates.size ? null : unreferencedAssetHashes(canonicalDir, rawDir, candidates, legacyMetadata);
  let blobsDeleted = 0;
  if (unreferenced) for (const hash of unreferenced) {
    const blob = assetBlobPath(canonicalDir, hash);
    if (existsSync(blob)) { rmSync(blob); blobsDeleted++; }
    if (existsSync(`${blob}.json`)) rmSync(`${blob}.json`);
    if (existsSync(dirname(blob))) syncDirectory(dirname(blob));
  }
  return { sessions, blobsDeleted };
}
