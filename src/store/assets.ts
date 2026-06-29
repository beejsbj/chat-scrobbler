import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";
import { sanitizePathSegment } from "../../packages/shared/src";
import type { ProviderSource } from "../../packages/shared/src";

export const MAX_ASSET_BYTES = 50 * 1024 * 1024;

export interface StoreAssetInput {
  canonicalDir: string;
  source: ProviderSource;
  sourceId: string;
  pointer: string;
  filename?: string | null;
  contentType?: string | null;
  bytes: Uint8Array;
}

export interface StoredAsset {
  local_path: string;
  sha256: string;
  size_bytes: number;
}

export function canonicalRootFromSessionsDir(canonicalDir: string): string {
  return dirname(canonicalDir);
}

export function assetsDirForCanonicalDir(canonicalDir: string): string {
  return join(canonicalRootFromSessionsDir(canonicalDir), "assets");
}

export function assetsDirForSession(canonicalDir: string, source: string, sourceId: string): string {
  return join(assetsDirForCanonicalDir(canonicalDir), sanitizePathSegment(source), sanitizePathSegment(sourceId));
}

export function resolveLocalAssetPath(canonicalDir: string, localPath: string): string {
  return join(canonicalRootFromSessionsDir(canonicalDir), localPath);
}

export function storeCanonicalAsset(input: StoreAssetInput): StoredAsset {
  if (!input.pointer.trim()) throw new Error("asset pointer is required");
  if (input.bytes.byteLength === 0) throw new Error("asset body is empty");
  if (input.bytes.byteLength > MAX_ASSET_BYTES) {
    throw new Error(`asset exceeds ${MAX_ASSET_BYTES} byte limit`);
  }

  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const ext = extensionFor(input.filename, input.contentType);
  const relPath = [
    "assets",
    sanitizePathSegment(input.source),
    sanitizePathSegment(input.sourceId),
    `${sha256}${ext}`,
  ].join("/");
  const absPath = resolveLocalAssetPath(input.canonicalDir, relPath);
  mkdirSync(dirname(absPath), { recursive: true });
  if (!existsSync(absPath)) writeFileSync(absPath, input.bytes);
  return {
    local_path: relPath,
    sha256,
    size_bytes: statSync(absPath).size,
  };
}

export function canonicalRelativePath(canonicalDir: string, absPath: string): string {
  return relative(canonicalRootFromSessionsDir(canonicalDir), absPath).split(sep).join("/");
}

function extensionFor(filename?: string | null, contentType?: string | null): string {
  const fromName = filename ? extname(filename).toLowerCase() : "";
  if (/^\.[a-z0-9]{1,12}$/.test(fromName)) return fromName;
  const normalized = contentType?.split(";")[0]?.trim().toLowerCase();
  switch (normalized) {
    case "image/png": return ".png";
    case "image/jpeg": return ".jpg";
    case "image/gif": return ".gif";
    case "image/webp": return ".webp";
    case "audio/mpeg": return ".mp3";
    case "audio/mp4": return ".m4a";
    case "audio/wav":
    case "audio/x-wav": return ".wav";
    case "application/pdf": return ".pdf";
    case "text/plain": return ".txt";
    default: return "";
  }
}
