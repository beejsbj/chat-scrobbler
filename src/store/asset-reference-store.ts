import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeAtomicFile, syncDirectory } from "./atomic-file";
import { writeImmutableFile } from "./immutable-file";
import { encodedSegment } from "./tombstones";
import { filesUnder } from "./asset-hashes";

const referenceDir = (root: string) => join(root, ".asset-refs");
const ownerPath = (root: string, source: string, id: string) => join(referenceDir(root), "owners", encodedSegment(source), `${encodedSegment(id)}.json`);
const hashOwnerPath = (root: string, hash: string, source: string, id: string) => join(referenceDir(root), "by-hash", hash, encodedSegment(source), `${encodedSegment(id)}.json`);
export const referenceStoreReady = (root: string) => existsSync(join(referenceDir(root), "ready"));
export function markReferencesReady(root: string): void { writeImmutableFile(join(referenceDir(root), "ready"), "1"); }
export function invalidateReferences(root: string): void {
  const ready = join(referenceDir(root), "ready");
  if (existsSync(ready)) { rmSync(ready); syncDirectory(dirname(ready)); }
}
export function ownedAssetHashes(root: string, source: string, id: string): Set<string> {
  const file = ownerPath(root, source, id);
  if (!existsSync(file)) return new Set();
  const hashes = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(hashes) || hashes.some(hash => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))) throw new Error("invalid asset ownership record");
  return new Set(hashes);
}
/** Retain historical ownership until deletion; per-hash names avoid archive scans during GC. */
export function recordAssetReferences(root: string, source: string, id: string, hashes: Set<string>): void {
  if (!["chatgpt", "claude", "gemini"].includes(source) || typeof id !== "string" || !id) throw new Error("invalid asset owner identity");
  const empty = !referenceStoreReady(root) && (!existsSync(root) || readdirSync(root).every(name => name.startsWith(".")));
  const previous = ownedAssetHashes(root, source, id);
  const next = new Set([...previous, ...hashes]);
  for (const hash of next) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("invalid asset hash");
    if (!previous.has(hash)) writeImmutableFile(hashOwnerPath(root, hash, source, id), "1");
  }
  if (next.size !== previous.size || [...next].some(hash => !previous.has(hash))) {
    writeAtomicFile(ownerPath(root, source, id), JSON.stringify([...next]));
  }
  if (empty && !referenceStoreReady(root)) markReferencesReady(root);
}
export function removeAssetOwner(root: string, source: string, id: string, knownHashes: Set<string> = new Set()): void {
  let hashes: Set<string>;
  try { hashes = ownedAssetHashes(root, source, id); }
  catch {
    // Corrupt owner manifests must not prevent erasure of the corresponding reference names.
    for (const file of filesUnder(join(referenceDir(root), "by-hash"), `*/${encodedSegment(source)}/${encodedSegment(id)}.json`)) removeFile(file);
    removeFile(ownerPath(root, source, id));
    return;
  }
  for (const hash of new Set([...hashes, ...knownHashes])) removeFile(hashOwnerPath(root, hash, source, id));
  removeFile(ownerPath(root, source, id));
}
export function hasAssetOwners(root: string, hash: string): boolean {
  return filesUnder(join(referenceDir(root), "by-hash", hash), "*/*.json").length > 0;
}
function removeFile(file: string): void {
  if (existsSync(file)) { rmSync(file); syncDirectory(dirname(file)); }
}
