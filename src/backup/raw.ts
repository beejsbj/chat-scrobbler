import { assetHashes } from "../store/asset-hashes";
import { recordAssetReferences } from "../store/asset-reference-store";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, futimesSync, linkSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { syncDirectory } from "../store/atomic-file";
import { writeImmutableFile } from "../store/immutable-file";
import type { BackupTarget } from "./target";

export function rawFiles(rawDir: string): string[] {
  return existsSync(rawDir) ? [...new Bun.Glob("**/*.json.gz").scanSync({ cwd: rawDir, onlyFiles: true, absolute: true })] : [];
}

export async function backupRaw(rawDir: string, target: BackupTarget, snapshot: string) {
  const files = rawFiles(rawDir);
  let bytes = 0;
  for (const file of files) {
    bytes += statSync(file).size;
    await target.putFile(snapshot, `raw/${relative(rawDir, file).split("\\").join("/")}`, file);
  }
  return { raw_file_count: files.length, raw_total_bytes: bytes };
}

export interface RestoreRawResult { restored: number; repaired: number; already_present: number }

export async function restoreRaw(rawDir: string, target: BackupTarget, snapshot: string, isDeleted: (source: string, id: string) => boolean = () => false): Promise<RestoreRawResult> {
  const result: RestoreRawResult = { restored: 0, repaired: 0, already_present: 0 };
  const files = target.listFiles(snapshot).filter(path => path.startsWith("raw/") && path.endsWith(".json.gz"));
  if (!files.length) return result;
  const temp = mkdtempSync(join(tmpdir(), "restore-raw-"));
  try {
    for (const file of files) {
      const dest = resolve(rawDir, file.slice(4));
      const rel = relative(resolve(rawDir), dest);
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("invalid raw snapshot path");
      const downloaded = join(temp, "capture.json.gz");
      await target.getFile(snapshot, file, downloaded);
      const bytes = readFileSync(downloaded);
      const capture = JSON.parse(Buffer.from(Bun.gunzipSync(bytes)).toString("utf8"));
      if (isDeleted(capture.source, capture.source_id)) continue;
      recordAssetReferences(rawDir, capture.source, capture.source_id, assetHashes(capture));
      result[restoreRawFile(dest, bytes)]++;
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
  return result;
}

/** Raw versions are never overwritten on ingest, but a forced restore must not
 *  trust a damaged local copy. Identical files are left alone. */
function restoreRawFile(dest: string, bytes: Buffer): keyof RestoreRawResult {
  if (!existsSync(dest)) {
    writeImmutableFile(dest, bytes);
    // Ingest may publish the same name first; that copy is checked like any other.
    if (readFileSync(dest).equals(bytes)) return "restored";
  } else if (readFileSync(dest).equals(bytes)) return "already_present";
  repairRawFile(dest, bytes);
  return "repaired";
}

/** Keep the differing bytes as `<name>.mismatch-<timestamp>`, which no `*.json.gz`
 *  scan lists, then atomically replace the version so it is never missing. */
function repairRawFile(dest: string, bytes: Buffer): void {
  const { atime, mtime } = statSync(dest);
  const temp = `${dest}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, bytes);
      // Archives without a latest marker pick their newest version by mtime.
      futimesSync(fd, atime, mtime);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    linkSync(dest, `${dest}.mismatch-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    syncDirectory(dirname(dest));
    renameSync(temp, dest);
    syncDirectory(dirname(dest));
  } finally { rmSync(temp, { force: true }); }
}
