import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Publish complete bytes atomically; an existing record is never overwritten. */
export function writeImmutableFile(path: string, bytes: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    try { linkSync(temp, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally { closeSync(fd); unlinkSync(temp); }
}
