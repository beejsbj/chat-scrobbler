// src/backup/backup.ts
//
// Orchestration: createBackup, listBackups, restoreBackup.
// Works over any BackupTarget so the storage layer is fully swappable.

import { existsSync, statSync, readFileSync, mkdtempSync, writeFileSync as fsWrite, rmSync } from "node:fs";
import { join, relative, basename, sep } from "node:path";
import { tmpdir } from "node:os";
import { listSessionFiles } from "../store/sessions";
import type { BackupTarget } from "./target";

// ---------------------------------------------------------------------------
// Manifest schema
// ---------------------------------------------------------------------------

export interface BackupManifest {
  /** ISO timestamp of when the snapshot was created. */
  created_at: string;
  /** Number of canonical session JSON files copied. */
  session_file_count: number;
  /** Total bytes of all session files. */
  total_bytes: number;
  /** Absolute path to the canonical dir at backup time. */
  canonical_dir: string;
  /** Schema version for forward-compat. Always 1. */
  schema: 1;
}

// ---------------------------------------------------------------------------
// createBackup
// ---------------------------------------------------------------------------

export interface CreateBackupOptions {
  /** Absolute path to canonical/sessions (the source of truth). */
  canonicalDir: string;
  /** Resolved backup target. */
  target: BackupTarget;
  /**
   * Optional path to the project config file to include in the snapshot.
   * Silently omitted when the path is absent or the file does not exist.
   */
  configPath?: string;
  /**
   * Override the generated snapshot name (for deterministic tests).
   * When omitted a UTC timestamp name is generated.
   */
  snapshotName?: string;
}

export interface CreateBackupResult {
  /** The snapshot name that was created. */
  snapshot: string;
  /** The manifest written into the snapshot. */
  manifest: BackupManifest;
  /** Human-readable label from target.describe(). */
  targetLabel: string;
}

export async function createBackup(opts: CreateBackupOptions): Promise<CreateBackupResult> {
  const { canonicalDir, target, configPath, snapshotName } = opts;

  const snapshot = snapshotName ?? generateSnapshotName();
  const createdAt = new Date().toISOString();

  // Gather canonical session files
  const sessionFiles = listSessionFiles(canonicalDir);
  let totalBytes = 0;

  for (const absPath of sessionFiles) {
    // rel is e.g. "chatgpt/abc123.json"
    const rel = relative(canonicalDir, absPath).split(sep).join("/");
    const relInSnapshot = `canonical/${rel}`;
    const bytes = statSync(absPath).size;
    totalBytes += bytes;
    await target.putFile(snapshot, relInSnapshot, absPath);
  }

  // Optionally include the config file
  if (configPath && existsSync(configPath)) {
    const configFilename = basename(configPath);
    await target.putFile(snapshot, `config/${configFilename}`, configPath);
  }

  // Build and write manifest
  const manifest: BackupManifest = {
    created_at: createdAt,
    session_file_count: sessionFiles.length,
    total_bytes: totalBytes,
    canonical_dir: canonicalDir,
    schema: 1,
  };

  // Write manifest to a temp file then put it into the target
  const tmpDir = mkdtempSync(join(tmpdir(), "backup-manifest-"));
  const tmpManifest = join(tmpDir, "manifest.json");
  try {
    fsWrite(tmpManifest, JSON.stringify(manifest, null, 2));
    await target.putFile(snapshot, "manifest.json", tmpManifest);
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  return { snapshot, manifest, targetLabel: target.describe() };
}

// ---------------------------------------------------------------------------
// listBackups
// ---------------------------------------------------------------------------

export interface BackupEntry {
  snapshot: string;
  manifest: BackupManifest | null;
}

export async function listBackups(target: BackupTarget): Promise<BackupEntry[]> {
  const snapshots = target.listSnapshots();

  const entries: BackupEntry[] = snapshots.map(snapshot => {
    const files = target.listFiles(snapshot);
    if (!files.includes("manifest.json")) {
      return { snapshot, manifest: null };
    }
    // Read manifest from target: get it into a temp file then parse
    let manifest: BackupManifest | null = null;
    const tmpDir = mkdtempSync(join(tmpdir(), "backup-list-"));
    const tmpManifest = join(tmpDir, "manifest.json");
    try {
      target.getFile(snapshot, "manifest.json", tmpManifest);
      manifest = JSON.parse(readFileSync(tmpManifest, "utf8")) as BackupManifest;
    } catch {
      manifest = null;
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    return { snapshot, manifest };
  });

  // Sort newest first (lexicographic descending on snapshot name works for
  // "snapshot-YYYYMMDD-HHMMSS" format)
  entries.sort((a, b) => (a.snapshot > b.snapshot ? -1 : a.snapshot < b.snapshot ? 1 : 0));
  return entries;
}

// ---------------------------------------------------------------------------
// restoreBackup
// ---------------------------------------------------------------------------

export interface RestoreBackupOptions {
  /** The backup target to restore from. */
  target: BackupTarget;
  /** The snapshot name to restore. */
  snapshot: string;
  /** Absolute path to the canonical dir to restore into. */
  canonicalDir: string;
  /**
   * When false (default) the restore refuses if canonicalDir already contains
   * session files to prevent accidental overwrites.
   */
  force?: boolean;
}

export interface RestoreBackupResult {
  /** Number of session files restored. */
  restored_count: number;
}

export async function restoreBackup(opts: RestoreBackupOptions): Promise<RestoreBackupResult> {
  const { target, snapshot, canonicalDir, force = false } = opts;

  // Refusal guard: check if canonical dir has existing session files
  if (!force) {
    const existing = listSessionFiles(canonicalDir);
    if (existing.length > 0) {
      throw new Error(
        `canonicalDir "${canonicalDir}" is not empty (${existing.length} session file(s) found). ` +
          `Pass force: true to overwrite.`,
      );
    }
  }

  const files = target.listFiles(snapshot);
  const sessionRelPaths = files.filter(
    f => f.startsWith("canonical/") && f.endsWith(".json"),
  );

  for (const relPath of sessionRelPaths) {
    // relPath is e.g. "canonical/chatgpt/abc.json"
    // Strip the "canonical/" prefix to get the path relative to canonicalDir
    const relInCanonical = relPath.slice("canonical/".length);
    const destAbs = join(canonicalDir, relInCanonical);
    await target.getFile(snapshot, relPath, destAbs);
  }

  return { restored_count: sessionRelPaths.length };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

export function generateSnapshotName(): string {
  const now = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const date =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  const time =
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `snapshot-${date}-${time}`;
}
