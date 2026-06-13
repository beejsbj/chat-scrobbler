// src/backup/target.ts
//
// BackupTarget interface: the storage abstraction that keeps the backend
// swappable. Orchestration code talks only to this interface; LocalDirTarget,
// future SFTP targets, future S3 targets all implement it.

import { LocalDirTarget } from "./local";

/**
 * A storage backend that can hold one or more named snapshots.
 * Each snapshot is a flat namespace of relative paths (e.g.
 * "canonical/chatgpt/abc.json", "manifest.json").
 */
export interface BackupTarget {
  /**
   * Write srcAbsPath into the snapshot under the given relative path.
   * The implementation must create any missing directories.
   */
  putFile(snapshot: string, relPath: string, srcAbsPath: string): void | Promise<void>;

  /**
   * Read a file from the snapshot and write it to destAbsPath.
   * The implementation must create any missing parent directories.
   */
  getFile(snapshot: string, relPath: string, destAbsPath: string): void | Promise<void>;

  /**
   * List all relative paths stored in a snapshot (e.g.
   * ["manifest.json", "canonical/chatgpt/abc.json"]).
   */
  listFiles(snapshot: string): string[];

  /**
   * List all snapshot names in this target (e.g.
   * ["snapshot-20250101-000000", "snapshot-20250202-120000"]).
   */
  listSnapshots(): string[];

  /**
   * A human-readable label shown in status messages (e.g. "local dir /tmp/bk").
   */
  describe(): string;
}

/**
 * Turn a spec string into a concrete BackupTarget.
 *
 * Rules:
 *   - Any plain path (absolute or relative): LocalDirTarget.
 *   - sftp:// or s3:// prefix: throws a "not implemented yet, use a local path" error.
 */
export function resolveTarget(spec: string): BackupTarget {
  if (spec.startsWith("sftp://") || spec.startsWith("s3://")) {
    throw new Error(
      `Backup target "${spec}" is not implemented yet, use a local path instead.`,
    );
  }
  return new LocalDirTarget(spec);
}
