import { basename, join, relative } from "node:path";
import { assetsDirForCanonicalDir } from "./assets";
import { isSessionDeleted } from "./tombstones";
import { listSessionFiles } from "./sessions";
import { assetHashes, filesUnder, readArchiveJson } from "./asset-hashes";
import { hasAssetOwners, markReferencesReady, recordAssetReferences, referenceStoreReady } from "./asset-reference-store";
export { captureHashes, collectAssetHashes, filesUnder } from "./asset-hashes";

/** Old archives need one initialization pass; new writes maintain ownership directly. */
export function unreferencedAssetHashes(canonicalDir: string, rawDir: string, candidates: Set<string>, legacyMetadata?: any[]): Set<string> | null {
  if (!candidates.size) return new Set();
  const assetsDir = assetsDirForCanonicalDir(canonicalDir);
  try {
    if (!referenceStoreReady(canonicalDir)) {
      for (const file of listSessionFiles(canonicalDir)) {
        const session = readArchiveJson(file);
        recordAssetReferences(canonicalDir, session.source, session.source_id, assetHashes(session));
      }
      markReferencesReady(canonicalDir);
    }
    if (!referenceStoreReady(rawDir)) {
      for (const file of filesUnder(rawDir, "**/*.json.gz")) {
        const capture = readArchiveJson(file);
        recordAssetReferences(rawDir, capture.source, capture.source_id, assetHashes(capture));
      }
      markReferencesReady(rawDir);
    }
    if (!referenceStoreReady(assetsDir)) {
      const metadata = legacyMetadata ?? filesUnder(join(assetsDir, "sha256"), "**/*.json").map(readArchiveJson);
      for (const record of metadata) {
        const owner = record.first_seen?.session_id;
        if (typeof owner !== "string") continue;
        const colon = owner.indexOf(":");
        const source = owner.slice(0, colon), id = owner.slice(colon + 1);
        if (!isSessionDeleted(canonicalDir, source, id)) recordAssetReferences(assetsDir, source, id, assetHashes(record.sha256));
      }
      for (const file of filesUnder(assetsDir)) {
        const [source, id] = relative(assetsDir, file).split(/[\/\\]/);
        if (source === "sha256" || source.startsWith(".")) continue;
        recordAssetReferences(assetsDir, source, id, assetHashes(basename(file)));
      }
      markReferencesReady(assetsDir);
    }
    return new Set([...candidates].filter(hash => ![canonicalDir, rawDir, assetsDir].some(root => hasAssetOwners(root, hash))));
  } catch {
    console.error(JSON.stringify({ event: "asset_cleanup_deferred", reason: "unreadable_surviving_reference" }));
    return null;
  }
}
