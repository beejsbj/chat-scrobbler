// test/backup.test.ts
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSession, readSession, listSessionFiles } from "../src/store/sessions";
import { resolveTarget } from "../src/backup/target";
import { LocalDirTarget } from "../src/backup/local";
import { createBackup, listBackups, restoreBackup } from "../src/backup/backup";
import type { Session } from "../src/schema/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const temps: string[] = [];
function makeTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}

afterEach(() => {
  for (const d of temps.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function makeSession(source: "chatgpt" | "claude" | "gemini", sourceId: string): Session {
  return {
    id: `${source}:${sourceId}`,
    source,
    source_id: sourceId,
    capture_method: "export",
    title: `Session ${sourceId}`,
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:10:00Z",
    default_model: null,
    account: null,
    raw_ref: `${source}-chats:${sourceId}`,
    schema_version: 1,
    messages: [
      {
        id: "m1",
        role: "user",
        created_at: null,
        parent_id: null,
        model: null,
        blocks: [{ type: "text", text: `Hello from ${sourceId}` }],
        text: `Hello from ${sourceId}`,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// resolveTarget
// ---------------------------------------------------------------------------

test("resolveTarget: absolute path returns a LocalDirTarget", () => {
  const backupDir = makeTmp("bk-resolve-");
  const target = resolveTarget(backupDir);
  expect(target.describe()).toContain(backupDir);
});

test("resolveTarget: relative path returns a LocalDirTarget", () => {
  const target = resolveTarget("./some/relative/path");
  expect(target.describe()).toMatch(/relative/);
});

test("resolveTarget: sftp:// throws a clear not-implemented error", () => {
  expect(() => resolveTarget("sftp://example.com/backups")).toThrow(
    /not implemented yet.*use a local path/i,
  );
});

test("resolveTarget: s3:// throws a clear not-implemented error", () => {
  expect(() => resolveTarget("s3://my-bucket/chat-scrobbler")).toThrow(
    /not implemented yet.*use a local path/i,
  );
});

// ---------------------------------------------------------------------------
// Round-trip: createBackup + restoreBackup
// ---------------------------------------------------------------------------

test("round-trip: backup 3 sessions across 2 sources then restore into wiped canonical dir", async () => {
  const canonicalDir = makeTmp("canonical-");
  const backupDir = makeTmp("backup-");

  // Write 3 sessions: 2 chatgpt, 1 claude
  const s1 = makeSession("chatgpt", "gpt-001");
  const s2 = makeSession("chatgpt", "gpt-002");
  const s3 = makeSession("claude", "cl-001");
  writeSession(canonicalDir, s1);
  writeSession(canonicalDir, s2);
  writeSession(canonicalDir, s3);

  const target = new LocalDirTarget(backupDir);

  // Create backup
  const result = await createBackup({ canonicalDir, target });
  const { snapshot, manifest, targetLabel } = result;

  // Snapshot name format
  expect(snapshot).toMatch(/^snapshot-\d{8}-\d{6}$/);
  // Manifest checks
  expect(manifest.session_file_count).toBe(3);
  expect(manifest.schema).toBe(1);
  expect(typeof manifest.total_bytes).toBe("number");
  expect(manifest.total_bytes).toBeGreaterThan(0);
  expect(manifest.canonical_dir).toBe(canonicalDir);
  // targetLabel non-empty
  expect(typeof targetLabel).toBe("string");
  expect(targetLabel.length).toBeGreaterThan(0);

  // Files exist in the backup
  const snapshotFiles = target.listFiles(snapshot);
  expect(snapshotFiles).toContain("canonical/chatgpt/gpt-001.json");
  expect(snapshotFiles).toContain("canonical/chatgpt/gpt-002.json");
  expect(snapshotFiles).toContain("canonical/claude/cl-001.json");
  expect(snapshotFiles).toContain("manifest.json");

  // Wipe canonical dir
  rmSync(canonicalDir, { recursive: true, force: true });
  expect(listSessionFiles(canonicalDir)).toHaveLength(0);

  // Restore
  const restoreResult = await restoreBackup({ target, snapshot, canonicalDir });
  expect(restoreResult.restored_count).toBe(3);

  // Sessions deep-equal originals
  expect(readSession(canonicalDir, "chatgpt", "gpt-001")).toEqual(s1);
  expect(readSession(canonicalDir, "chatgpt", "gpt-002")).toEqual(s2);
  expect(readSession(canonicalDir, "claude", "cl-001")).toEqual(s3);
});

// ---------------------------------------------------------------------------
// Refusal: non-empty canonical dir without force
// ---------------------------------------------------------------------------

test("restoreBackup refuses non-empty canonical dir without force flag", async () => {
  const canonicalDir = makeTmp("canonical-noforce-");
  const backupDir = makeTmp("backup-noforce-");

  const s1 = makeSession("chatgpt", "gpt-010");
  writeSession(canonicalDir, s1);

  const target = new LocalDirTarget(backupDir);
  const { snapshot } = await createBackup({ canonicalDir, target });

  // Canonical dir still has files -- restore should refuse
  await expect(
    restoreBackup({ target, snapshot, canonicalDir }),
  ).rejects.toThrow(/not empty.*force/i);
});

test("restoreBackup succeeds into non-empty canonical dir with force: true", async () => {
  const canonicalDir = makeTmp("canonical-force-");
  const backupDir = makeTmp("backup-force-");

  const s1 = makeSession("gemini", "gem-001");
  writeSession(canonicalDir, s1);

  const target = new LocalDirTarget(backupDir);
  const { snapshot } = await createBackup({ canonicalDir, target });

  // Should succeed with force
  const result = await restoreBackup({ target, snapshot, canonicalDir, force: true });
  expect(result.restored_count).toBe(1);
  expect(readSession(canonicalDir, "gemini", "gem-001")).toEqual(s1);
});

// ---------------------------------------------------------------------------
// listBackups ordering (newest first)
// ---------------------------------------------------------------------------

test("listBackups returns snapshots sorted newest first", async () => {
  const canonicalDir = makeTmp("canonical-list-");
  const backupDir = makeTmp("backup-list-");

  writeSession(canonicalDir, makeSession("chatgpt", "gpt-100"));

  const target = new LocalDirTarget(backupDir);

  // Create two snapshots with distinct injected names
  await createBackup({ canonicalDir, target, snapshotName: "snapshot-20250101-000000" });
  await createBackup({ canonicalDir, target, snapshotName: "snapshot-20250202-000000" });

  const backups = await listBackups(target);

  expect(backups.length).toBe(2);
  // Newest first
  expect(backups[0].snapshot).toBe("snapshot-20250202-000000");
  expect(backups[1].snapshot).toBe("snapshot-20250101-000000");
  // Both have manifests
  expect(backups[0].manifest).not.toBeNull();
  expect(backups[1].manifest).not.toBeNull();
});

test("listBackups tolerates a snapshot directory missing its manifest", async () => {
  const backupDir = makeTmp("backup-nomanifest-");
  // Create a snapshot dir with no manifest.json inside
  mkdirSync(join(backupDir, "snapshot-20250303-120000"), { recursive: true });

  const target = new LocalDirTarget(backupDir);
  const backups = await listBackups(target);

  expect(backups.length).toBe(1);
  expect(backups[0].snapshot).toBe("snapshot-20250303-120000");
  expect(backups[0].manifest).toBeNull();
});

// ---------------------------------------------------------------------------
// createBackup with a missing configPath still succeeds
// ---------------------------------------------------------------------------

test("createBackup succeeds when configPath does not exist (canonical only)", async () => {
  const canonicalDir = makeTmp("canonical-cfg-");
  const backupDir = makeTmp("backup-cfg-");

  writeSession(canonicalDir, makeSession("claude", "cl-999"));

  const target = new LocalDirTarget(backupDir);
  const result = await createBackup({
    canonicalDir,
    target,
    configPath: "/nonexistent/path/chat-scrobbler.config.json",
  });

  expect(result.manifest.session_file_count).toBe(1);
  // No config/ entry in file list
  const files = target.listFiles(result.snapshot);
  expect(files.some(f => f.startsWith("config/"))).toBe(false);
});

test("createBackup includes the config file when configPath exists", async () => {
  const canonicalDir = makeTmp("canonical-cfgexist-");
  const backupDir = makeTmp("backup-cfgexist-");
  const configDir = makeTmp("configdir-");

  writeSession(canonicalDir, makeSession("claude", "cl-888"));

  // Write a real config file
  const configPath = join(configDir, "chat-scrobbler.config.json");
  Bun.write(configPath, JSON.stringify({ backupTarget: backupDir }));

  const target = new LocalDirTarget(backupDir);
  const result = await createBackup({ canonicalDir, target, configPath });

  const files = target.listFiles(result.snapshot);
  expect(files.some(f => f.startsWith("config/"))).toBe(true);
});
