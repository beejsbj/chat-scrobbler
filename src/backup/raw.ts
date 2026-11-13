import { assetHashes } from "../store/asset-hashes";
import { recordAssetReferences } from "../store/asset-reference-store";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, futimesSync, linkSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { syncDirectory } from "../store/atomic-file";
import { writeImmutableFile } from "../store/immutable-file";
import { restoreLatestRaw } from "../store/raw-latest";

const VERSION = /^.+-[a-f0-9]{64}\.json\.gz$/;
import type { BackupTarget } from "./target";

export function rawFiles(rawDir: string): string[] {
  return existsSync(rawDir) ? [...new Bun.Glob("**/*.json.gz").scanSync({ cwd: rawDir, onlyFiles: true, absolute: true })] : [];
}

function rawMarkers(rawDir: string): string[] {
  return existsSync(rawDir) ? [...new Bun.Glob("*/*/latest.json").scanSync({ cwd: rawDir, onlyFiles: true, absolute: true })] : [];
}

export async function backupRaw(rawDir: string, target: BackupTarget, snapshot: string) {
  const files = rawFiles(rawDir);
  let bytes = 0;
  for (const file of files) {
    bytes += statSync(file).size;
    await target.putFile(snapshot, `raw/${relative(rawDir, file).split("\\").join("/")}`, file);
  }
  // Markers record arrival order, which restored mtimes cannot.
  for (const marker of rawMarkers(rawDir)) await target.putFile(snapshot, `raw/${relative(rawDir, marker).split("\\").join("/")}`, marker);
  return { raw_file_count: files.length, raw_total_bytes: bytes };
}

export interface RestoreRawResult { restored: number; repaired: number; already_present: number; kept_aside: string[] }

export async function restoreRaw(rawDir: string, target: BackupTarget, snapshot: string, isDeleted: (source: string, id: string) => boolean = () => false): Promise<RestoreRawResult> {
  const result: RestoreRawResult = { restored: 0, repaired: 0, already_present: 0, kept_aside: [] };
  const listed = target.listFiles(snapshot);
  const files = listed.filter(path => path.startsWith("raw/") && path.endsWith(".json.gz"));
  if (!files.length) return result;
  const temp = mkdtempSync(join(tmpdir(), "restore-raw-"));
  const restored = new Set<string>();
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
      const aside = restoreRawFile(dest, bytes);
      if (aside === "restored") restored.add(dest);
      if (aside === "restored" || aside === "already_present") result[aside]++;
      else { result.repaired++; result.kept_aside.push(aside); }
    }
    for (const file of listed.filter(path => /^raw\/[^/]+\/[^/]+\/latest\.json$/.test(path))) {
      const dir = resolve(rawDir, dirname(file.slice(4)));
      const rel = relative(resolve(rawDir), dir);
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("invalid raw snapshot path");
      let source: string, id: string;
      try { [source, id] = rel.split(sep).map(decodeURIComponent); } catch { continue; }
      if (isDeleted(source, id)) continue;
      const downloaded = join(temp, "latest.json");
      await target.getFile(snapshot, file, downloaded);
      let name: unknown;
      try { name = JSON.parse(readFileSync(downloaded, "utf8")).file; } catch { continue; }
      // Without a usable marker, latestRaw falls back to fetched_at order.
      if (typeof name !== "string" || !VERSION.test(name) || /[\/\\]/.test(name) || !existsSync(join(dir, name))) continue;
      // Read the local marker after the download, so one ingest wrote meanwhile is seen.
      let local: string | null;
      try { local = readFileSync(join(dir, "latest.json"), "utf8"); }
      catch (error) {
        // One that cannot be read is left for ingest to report, not a reason to abort.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
        local = null;
      }
      if (local !== null && !staleMarker(local, dir, name, file, listed, restored)) continue;
      restoreLatestRaw(dir, name, local);
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
  return result;
}

/** A local marker is newer evidence than the snapshot's, since local ingest wrote it,
 *  unless it is unusable or names a version the snapshot also holds while the snapshot's
 *  marker names one this restore had to add: then the snapshot has seen strictly more. */
function staleMarker(local: string, dir: string, snapshotName: string, snapshotMarker: string, listed: string[], restored: Set<string>): boolean {
  let file: unknown;
  try { file = JSON.parse(local).file; } catch { return true; }
  if (typeof file !== "string" || !VERSION.test(file) || /[\/\\]/.test(file) || !existsSync(join(dir, file))) return true;
  return file !== snapshotName && restored.has(join(dir, snapshotName)) && listed.includes(`${dirname(snapshotMarker)}/${file}`);
}

/** Raw versions are never overwritten on ingest, but a forced restore must not
 *  trust a damaged local copy. Identical files are left alone; a repaired one
 *  returns the path its local bytes were kept at. */
function restoreRawFile(dest: string, bytes: Buffer): "restored" | "already_present" | string {
  if (!existsSync(dest)) {
    writeImmutableFile(dest, bytes);
    // Ingest may publish the same name first; that copy is checked like any other.
    if (sameBytes(dest, bytes)) return "restored";
  } else if (sameBytes(dest, bytes)) return "already_present";
  return repairRawFile(dest, bytes);
}

/** A local copy that cannot be read (EIO, EACCES) is damaged, not a reason to abort. */
function sameBytes(path: string, bytes: Buffer): boolean {
  try { return readFileSync(path).equals(bytes); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error; return false; }
}

/** Keep the differing bytes as `<name>.mismatch-<timestamp>`, which no `*.json.gz`
 *  scan lists, then atomically replace the version so it is never missing. */
function repairRawFile(dest: string, bytes: Buffer): string {
  const aside = `${dest}.mismatch-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const { atime, mtime } = statSync(dest);
  const temp = `${dest}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, bytes);
      // Archives without a latest marker break fetched_at ties by mtime.
      futimesSync(fd, atime, mtime);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    linkSync(dest, aside);
    syncDirectory(dirname(dest));
    renameSync(temp, dest);
    syncDirectory(dirname(dest));
  } finally { rmSync(temp, { force: true }); }
  return aside;
}
