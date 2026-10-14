import { recordAssetReferences } from "./asset-reference-store";
import { assertSessionNotDeleted } from "./tombstones";
import { assetBlobPath, assetsDirForCanonicalDir, extensionFor, resolveLocalAssetPath } from "./assets";
import { linkSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { sanitizePathSegment } from "../../packages/shared/src";
import type { ProviderSource } from "../../packages/shared/src";
import type { StoredAsset } from "./assets";

export class AssetBlobMissingError extends Error {
  constructor() { super("asset blob not found"); }
}

/** Stat-only existence check; never reads blob bytes. */
export function lookupAssetBlob(canonicalDir: string, sha256: string): { size_bytes: number } | null {
  try {
    const stat = statSync(assetBlobPath(canonicalDir, sha256));
    return stat.isFile() ? { size_bytes: stat.size } : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export interface ReferenceAssetInput {
  canonicalDir: string;
  source: ProviderSource;
  sourceId: string;
  sha256: string;
  filename?: string | null;
  contentType?: string | null;
}

/** Reference an existing blob from a session: ownership record plus compatibility alias. Blob and metadata stay untouched. */
export function referenceExistingAsset(input: ReferenceAssetInput): StoredAsset {
  assertSessionNotDeleted(input.canonicalDir, input.source, input.sourceId);
  const blob = assetBlobPath(input.canonicalDir, input.sha256);
  if (!lookupAssetBlob(input.canonicalDir, input.sha256)) throw new AssetBlobMissingError();
  recordAssetReferences(assetsDirForCanonicalDir(input.canonicalDir), input.source, input.sourceId, new Set([input.sha256]));
  const relPath = ["assets", sanitizePathSegment(input.source), sanitizePathSegment(input.sourceId), `${input.sha256}${extensionFor(input.filename, input.contentType)}`].join("/");
  const absPath = resolveLocalAssetPath(input.canonicalDir, relPath);
  mkdirSync(dirname(absPath), { recursive: true });
  try { linkSync(blob, absPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  return { local_path: relPath, sha256: input.sha256, size_bytes: statSync(absPath).size };
}
