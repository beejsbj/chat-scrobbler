// src/backup/local.ts
//
// LocalDirTarget: a BackupTarget backed by a plain directory on the local
// filesystem. Snapshots are subdirectories; files are plain copies.
//
// Layout:
//   <baseDir>/
//     <snapshot>/
//       manifest.json
//       canonical/<source>/<source_id>.json
//       config/<filename>

import {
  mkdirSync,
  copyFileSync,
  readdirSync,
  existsSync,
  statSync,
} from "node:fs";
import { join, dirname, sep } from "node:path";
import type { BackupTarget } from "./target";

export class LocalDirTarget implements BackupTarget {
  constructor(private readonly baseDir: string) {}

  putFile(snapshot: string, relPath: string, srcAbsPath: string): void {
    const destAbs = join(this.baseDir, snapshot, relPath);
    mkdirSync(dirname(destAbs), { recursive: true });
    copyFileSync(srcAbsPath, destAbs);
  }

  getFile(snapshot: string, relPath: string, destAbsPath: string): void {
    mkdirSync(dirname(destAbsPath), { recursive: true });
    copyFileSync(join(this.baseDir, snapshot, relPath), destAbsPath);
  }

  listFiles(snapshot: string): string[] {
    const snapshotDir = join(this.baseDir, snapshot);
    if (!existsSync(snapshotDir)) return [];
    return walkRelative(snapshotDir, "");
  }

  listSnapshots(): string[] {
    if (!existsSync(this.baseDir)) return [];
    const entries: string[] = [];
    for (const name of readdirSync(this.baseDir)) {
      const full = join(this.baseDir, name);
      try {
        if (statSync(full).isDirectory()) entries.push(name);
      } catch {
        // skip unreadable entries
      }
    }
    return entries;
  }

  describe(): string {
    return `local dir ${this.baseDir}`;
  }
}

/** Recursively list all file paths relative to rootDir, using forward slashes. */
function walkRelative(rootDir: string, prefix: string): string[] {
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(join(rootDir, prefix));
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry}` : entry;
    const abs = join(rootDir, rel);
    try {
      if (statSync(abs).isDirectory()) {
        out.push(...walkRelative(rootDir, rel));
      } else {
        // Always use forward slashes for relPath keys regardless of OS sep
        out.push(rel.split(sep).join("/"));
      }
    } catch {
      // skip
    }
  }
  return out;
}
