import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
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

export async function restoreRaw(rawDir: string, target: BackupTarget, snapshot: string, isDeleted: (source: string, id: string) => boolean = () => false): Promise<number> {
  const files = target.listFiles(snapshot).filter(path => path.startsWith("raw/") && path.endsWith(".json.gz"));
  if (!files.length) return 0;
  const temp = mkdtempSync(join(tmpdir(), "restore-raw-"));
  let count = 0;
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
      writeImmutableFile(dest, bytes);
      count++;
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
  return count;
}
