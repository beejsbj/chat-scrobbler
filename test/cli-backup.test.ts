import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSession, readSession } from "../src/store/sessions";
import { DEFAULT_CONFIG, type ChatHistoryConfig } from "../src/config";
import { runBackup, runBackups, runRestore } from "../src/cli/commands";
import type { Session } from "../src/schema/types";

function sessionFixture(source: "chatgpt" | "claude", sourceId: string): Session {
  return {
    id: `${source}:${sourceId}`,
    source,
    source_id: sourceId,
    capture_method: "api",
    title: `t-${sourceId}`,
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    default_model: null,
    account: null,
    messages: [],
    raw_ref: `raw/api/${source}:${sourceId}`,
    schema_version: 1,
  };
}

function makeEnv(): { cfg: ChatHistoryConfig; root: string; out: string[]; write: (s: string) => void } {
  const root = mkdtempSync(join(tmpdir(), "cli-backup-"));
  const cfg: ChatHistoryConfig = {
    ...DEFAULT_CONFIG,
    canonicalDir: join(root, "canonical"),
    indexPath: join(root, "idx.db"),
    backupTargets: [join(root, "backups")],
  };
  const out: string[] = [];
  return { cfg, root, out, write: (s) => out.push(s) };
}

test("runBackup snapshots canonical into the configured target and reports counts", async () => {
  const { cfg, root, out, write } = makeEnv();
  try {
    writeSession(cfg.canonicalDir, sessionFixture("chatgpt", "aaa"));
    writeSession(cfg.canonicalDir, sessionFixture("claude", "bbb"));

    await runBackup({ cfg, write });

    const snapshots = readdirSync(cfg.backupTargets[0]);
    expect(snapshots.length).toBe(1);
    const snapDir = join(cfg.backupTargets[0], snapshots[0]);
    expect(existsSync(join(snapDir, "manifest.json"))).toBe(true);
    expect(existsSync(join(snapDir, "canonical", "chatgpt", "aaa.json"))).toBe(true);
    expect(out.join("\n")).toContain("2 session file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runBackups lists snapshots with manifests (json mode)", async () => {
  const { cfg, root, out, write } = makeEnv();
  try {
    writeSession(cfg.canonicalDir, sessionFixture("chatgpt", "aaa"));
    await runBackup({ cfg, write });
    out.length = 0;

    await runBackups({ cfg, json: true, write });
    const parsed = JSON.parse(out.join("\n"));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(1);
    expect(parsed[0].manifest.session_file_count).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runRestore round-trips sessions back into an empty canonical dir", async () => {
  const { cfg, root, out, write } = makeEnv();
  try {
    const original = sessionFixture("chatgpt", "aaa");
    writeSession(cfg.canonicalDir, original);
    await runBackup({ cfg, write });
    const snapshot = readdirSync(cfg.backupTargets[0])[0];

    rmSync(cfg.canonicalDir, { recursive: true, force: true });
    await runRestore({ cfg, snapshot, write });

    const restored = readSession(cfg.canonicalDir, "chatgpt", "aaa");
    expect(restored).toEqual(original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runRestore refuses a non-empty canonical dir without force", async () => {
  const { cfg, root, out, write } = makeEnv();
  try {
    writeSession(cfg.canonicalDir, sessionFixture("chatgpt", "aaa"));
    await runBackup({ cfg, write });
    const snapshot = readdirSync(cfg.backupTargets[0])[0];

    await expect(runRestore({ cfg, snapshot, write })).rejects.toThrow(/force/i);
    await runRestore({ cfg, snapshot, force: true, write });
    expect(out.join("\n")).toContain("Restored 1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runBackup writes the same snapshot name to every configured target", async () => {
  const { cfg, root, out, write } = makeEnv();
  try {
    const second = join(root, "backups-2");
    cfg.backupTargets = [cfg.backupTargets[0], second];
    writeSession(cfg.canonicalDir, sessionFixture("chatgpt", "aaa"));

    await runBackup({ cfg, write });

    const first = readdirSync(cfg.backupTargets[0]);
    const secondSnaps = readdirSync(second);
    expect(first.length).toBe(1);
    expect(secondSnaps).toEqual(first); // identical snapshot name
    expect(existsSync(join(second, secondSnaps[0], "manifest.json"))).toBe(true);
    expect(out.filter(l => l.includes("Backed up")).length).toBe(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runBackup continues past a failing target and throws an aggregate error", async () => {
  const { cfg, root, out, write } = makeEnv();
  try {
    cfg.backupTargets = ["sftp://not-implemented/yet", cfg.backupTargets[0]];
    writeSession(cfg.canonicalDir, sessionFixture("chatgpt", "aaa"));

    await expect(runBackup({ cfg, write })).rejects.toThrow(/sftp/);

    // The healthy target still got the snapshot.
    expect(readdirSync(cfg.backupTargets[1]).length).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runBackup --target overrides the list and writes only there", async () => {
  const { cfg, root, out, write } = makeEnv();
  try {
    const only = join(root, "only");
    writeSession(cfg.canonicalDir, sessionFixture("chatgpt", "aaa"));

    await runBackup({ cfg, targetSpec: only, write });

    expect(readdirSync(only).length).toBe(1);
    expect(existsSync(cfg.backupTargets[0])).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
