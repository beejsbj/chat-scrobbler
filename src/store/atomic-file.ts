import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Flush complete bytes, atomically replace the name, then flush its directory. */
export function writeAtomicFile(path: string, bytes: string | Uint8Array): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    renameSync(temp, path);
    syncDirectory(dir);
  } finally {
    closeSync(fd);
    try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
