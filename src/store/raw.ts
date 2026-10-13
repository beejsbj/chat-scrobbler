import { assetHashes } from "./asset-hashes";
import { recordAssetReferences } from "./asset-reference-store";
import { latestRaw, rawContentHash, writeLatestRaw } from "./raw-latest";
import { writeImmutableFile } from "./immutable-file";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { RawCapture } from "../../packages/shared/src";

/** Default layout: <data>/canonical/sessions, <data>/raw. */
export function rawDirForCanonicalDir(canonicalDir: string): string {
  const root = basename(canonicalDir) === "sessions" ? dirname(dirname(canonicalDir)) : dirname(canonicalDir);
  return join(root, "raw");
}

// Encoding, rather than lossy sanitization, keeps distinct provider IDs distinct.
function segment(value: string): string {
  return encodeURIComponent(value).replace(/\./g, "%2E");
}

export function listRawCaptures(rawDir: string, source: string, sourceId: string): string[] {
  const dir = join(rawDir, segment(source), segment(sourceId));
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => /^.+-[a-f0-9]{64}\.json\.gz$/.test(name))
    .sort().map(name => relative(rawDir, join(dir, name)));
}

/** Retain exact bytes when endpoint/payload changes; skip unchanged polling. */
export function storeRawCapture(rawDir: string, capture: RawCapture, serialized = JSON.stringify(capture)): string {
  const sessionDir = join(segment(capture.source), segment(capture.source_id));
  const dir = join(rawDir, sessionDir);
  recordAssetReferences(rawDir, capture.source, capture.source_id, assetHashes(capture));
  const contentHash = rawContentHash(capture);
  const latest = latestRaw(dir);
  if (latest?.content_hash === contentHash) return join(sessionDir, latest.file);
  const hash = createHash("sha256").update(serialized).digest("hex");
  const ref = join(segment(capture.source), segment(capture.source_id), `${capture.fetched_at.replace(/[^\dTZ-]/g, "-")}-${hash}.json.gz`);
  const path = join(rawDir, ref);
  writeImmutableFile(path, Bun.gzipSync(Buffer.from(serialized)));
  writeLatestRaw(dir, { file: basename(ref), content_hash: contentHash });
  return ref;
}

export function readRawCapture(rawDir: string, ref: string): RawCapture {
  const path = resolve(rawDir, ref);
  const rel = relative(resolve(rawDir), path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("raw reference must stay inside raw store");
  return JSON.parse(Buffer.from(Bun.gunzipSync(readFileSync(path))).toString("utf8"));
}
