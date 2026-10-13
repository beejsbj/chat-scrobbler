import { invalidateReferences } from "../store/asset-reference-store";
// src/backup/backup.ts
//
// Orchestration: createBackup, listBackups, restoreBackup.
// Works over any BackupTarget so the storage layer is fully swappable.

import { existsSync, statSync, readFileSync, mkdtempSync, writeFileSync as fsWrite, rmSync, readdirSync } from "node:fs";
import { join, relative, basename, sep } from "node:path";
import { tmpdir } from "node:os";
import { listSessionFiles, sessionFilePath, writeSession } from "../store/sessions";
import { isSessionDeleted, listTombstones, markSessionDeleted, tombstoneDir } from "../store/tombstones";
import { deleteSessionArchives } from "../store/delete";
import { backupRaw, rawFiles, restoreRaw } from "./raw";
import { rawDirForCanonicalDir } from "../store/raw";
import { assetsDirForCanonicalDir } from "../store/assets";
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
  /** Number of canonical asset files copied. */
  asset_file_count?: number;
  /** Total bytes of all asset files. */
  asset_total_bytes?: number;
  raw_file_count?: number;
  raw_total_bytes?: number;
  /** Absolute path to the canonical dir at backup time. */
  canonical_dir: string;
  /** Schema version for forward-compat. Always 1. */
  schema: 1;
}

// ---------------------------------------------------------------------------
// createBackup
// ---------------------------------------------------------------------------

export interface CreateBackupOptions {
  /** Absolute path to canonical/sessions; raw history is backed up alongside it. */
  canonicalDir: string;
  rawDir?: string;
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
  const assetsDir = assetsDirForCanonicalDir(canonicalDir);
  const assetFiles = listFilesRecursive(assetsDir);
  let totalBytes = 0;
  let assetTotalBytes = 0;

  for (const absPath of sessionFiles) {
    // rel is e.g. "chatgpt/abc123.json"
    const rel = relative(canonicalDir, absPath).split(sep).join("/");
    const relInSnapshot = `canonical/${rel}`;
    const bytes = statSync(absPath).size;
    totalBytes += bytes;
    await target.putFile(snapshot, relInSnapshot, absPath);
  }

  for (const absPath of assetFiles) {
    const rel = relative(assetsDir, absPath).split(sep).join("/");
    const relInSnapshot = `canonical/assets/${rel}`;
    const bytes = statSync(absPath).size;
    assetTotalBytes += bytes;
    await target.putFile(snapshot, relInSnapshot, absPath);
  }

  for (const file of listFilesRecursive(tombstoneDir(canonicalDir))) {
    await target.putFile(snapshot, `deleted/${relative(tombstoneDir(canonicalDir), file).split(sep).join("/")}`, file);
  }

  const rawStats = await backupRaw(opts.rawDir ?? rawDirForCanonicalDir(canonicalDir), target, snapshot);

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
    asset_file_count: assetFiles.length,
    asset_total_bytes: assetTotalBytes,
    ...rawStats,
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
  rawDir?: string;
  /**
   * When false (default) the restore refuses if canonicalDir already contains
   * session files to prevent accidental overwrites.
   */
  force?: boolean;
}

export interface RestoreBackupResult {
  /** Number of session files restored. */
  restored_count: number;
  /** Number of asset files restored. */
  restored_asset_count?: number;
  restored_raw_count?: number;
}

export async function restoreBackup(opts: RestoreBackupOptions): Promise<RestoreBackupResult> {
  const { target, snapshot, canonicalDir, force = false } = opts;

  // Refusal guard: check if canonical dir has existing session files
  if (!force) {
    const existing = listSessionFiles(canonicalDir);
    const existingAssets = listFilesRecursive(assetsDirForCanonicalDir(canonicalDir));
    const existingRaw = rawFiles(opts.rawDir ?? rawDirForCanonicalDir(canonicalDir));
    if (existing.length > 0 || existingAssets.length > 0 || existingRaw.length > 0) {
      throw new Error(
        `canonicalDir "${canonicalDir}" is not empty (${existing.length} session file(s), ${existingAssets.length} asset file(s) found). ` +
          `Pass force: true to overwrite.`,
      );
    }
  }

  const files = target.listFiles(snapshot);
  const sessionRelPaths = files.filter(
    f => f.startsWith("canonical/") && f.endsWith(".json"),
  );
  const assetRelPaths = files.filter(
    f => f.startsWith("canonical/assets/") && !f.endsWith("/"),
  );

  // Restore deletion policy first, including when force restores over existing data.
  const temp = mkdtempSync(join(tmpdir(), "restore-sessions-"));
  let restoredCount = 0;
  try {
    for (const file of files.filter(path => path.startsWith("deleted/") && path.endsWith(".json"))) {
      const downloaded = join(temp, "deleted.json");
      await target.getFile(snapshot, file, downloaded);
      const record = JSON.parse(readFileSync(downloaded, "utf8"));
      sessionFilePath(canonicalDir, record.source, record.source_id);
      if (typeof record.deleted_at !== "string" || !Number.isFinite(Date.parse(record.deleted_at))) throw new Error("invalid deletion tombstone");
      markSessionDeleted(canonicalDir, record);
    }
    for (const relPath of sessionRelPaths.filter(f => !f.startsWith("canonical/assets/"))) {
      const downloaded = join(temp, "session.json");
      await target.getFile(snapshot, relPath, downloaded);
      const session = JSON.parse(readFileSync(downloaded, "utf8"));
      if (isSessionDeleted(canonicalDir, session.source, session.source_id)) continue;
      writeSession(canonicalDir, session);
      restoredCount++;
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }

  const assetsDir = assetsDirForCanonicalDir(canonicalDir);
  for (const relPath of assetRelPaths) {
    const relInAssets = relPath.slice("canonical/assets/".length);
    const destAbs = join(assetsDir, relInAssets);
    await target.getFile(snapshot, relPath, destAbs);
  }

  // Reference records are derived. Restored legacy aliases require one fresh ownership pass.
  invalidateReferences(assetsDir);
  const restored_raw_count = await restoreRaw(opts.rawDir ?? rawDirForCanonicalDir(canonicalDir), target, snapshot, (source, id) => isSessionDeleted(canonicalDir, source, id));
  deleteSessionArchives(canonicalDir, listTombstones(canonicalDir), opts.rawDir);
  return { restored_count: restoredCount, restored_asset_count: assetRelPaths.length, restored_raw_count };
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

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(abs));
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}
