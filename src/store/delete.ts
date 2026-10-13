import { existsSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { assetBlobPath, assetsDirForCanonicalDir, assetsDirForSession } from "./assets";
import { captureHashes, collectAssetHashes, filesUnder, survivingAssetHashes } from "./asset-references";
import { deleteSession, sessionFilePath } from "./sessions";
import { rawDirForCanonicalDir } from "./raw";
import { encodedSegment, markSessionDeleted } from "./tombstones";
import { syncDirectory } from "./atomic-file";

export function deleteSessionArchive(canonicalDir: string, source: string, sourceId: string, rawDir = rawDirForCanonicalDir(canonicalDir)) {
  const sessionPath = sessionFilePath(canonicalDir, source, sourceId);
  markSessionDeleted(canonicalDir, { source, source_id: sourceId, deleted_at: new Date().toISOString() });
  const rawSessionDir = join(rawDir, encodedSegment(source), encodedSegment(sourceId));
  const candidates = new Set<string>();
  let collectionFailed = false;
  const collect = (step: () => void) => {
    try { step(); } catch { collectionFailed = true; }
  };
  collect(() => { if (existsSync(sessionPath)) captureHashes(sessionPath, candidates); });
  collect(() => { for (const file of filesUnder(rawSessionDir, "*.json.gz")) collect(() => captureHashes(file, candidates)); });
  collect(() => { for (const file of filesUnder(assetsDirForSession(canonicalDir, source, sourceId))) collect(() => collectAssetHashes(basename(file), candidates)); });
  collect(() => { for (const file of filesUnder(join(assetsDirForCanonicalDir(canonicalDir), "sha256"), "**/*.json")) collect(() => {
    const metadata = JSON.parse(readFileSync(file, "utf8"));
    if (metadata.first_seen?.session_id === `${source}:${sourceId}`) collectAssetHashes(metadata.sha256, candidates);
  }); });
  if (collectionFailed) console.error(JSON.stringify({ event: "asset_cleanup_deferred", reason: "unreadable_deleted_reference" }));
  const result = deleteSession(canonicalDir, source, sourceId);
  const rawDeleted = existsSync(rawSessionDir);
  if (rawDeleted) { rmSync(rawSessionDir, { recursive: true, force: true }); syncDirectory(dirname(rawSessionDir)); }
  const survivors = collectionFailed ? null : survivingAssetHashes(canonicalDir, rawDir);
  let blobsDeleted = 0;
  if (survivors) for (const hash of candidates) {
    if (survivors.has(hash)) continue;
    const blob = assetBlobPath(canonicalDir, hash);
    if (existsSync(blob)) { rmSync(blob); blobsDeleted++; }
    if (existsSync(`${blob}.json`)) rmSync(`${blob}.json`);
    if (existsSync(dirname(blob))) syncDirectory(dirname(blob));
  }
  return { ...result, rawDeleted, blobsDeleted };
}
