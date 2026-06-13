import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type ChatHistoryConfig } from "../src/config";
import { runInit } from "../src/cli/commands";

function makeEnv(): { cfg: ChatHistoryConfig; root: string; out: string[]; write: (s: string) => void } {
  const root = mkdtempSync(join(tmpdir(), "cli-init-"));
  const cfg: ChatHistoryConfig = {
    ...DEFAULT_CONFIG,
    canonicalDir: join(root, "canonical", "sessions"),
    indexPath: join(root, "index", "sessions.db"),
    backupTargets: [join(root, "backups")],
  };
  const out: string[] = [];
  return { cfg, root, out, write: (s) => out.push(s) };
}

test("runInit scaffolds data dirs and writes a starter config file", async () => {
  const { cfg, root, out, write } = makeEnv();
  try {
    const configFile = join(root, "chat-scrobbler.config.json");
    await runInit({ cfg, configFilePath: configFile, write });

    expect(existsSync(cfg.canonicalDir)).toBe(true);
    expect(existsSync(join(root, "index"))).toBe(true);
    expect(existsSync(configFile)).toBe(true);

    const written = JSON.parse(readFileSync(configFile, "utf8"));
    expect(written.canonicalDir).toBe(cfg.canonicalDir);
    expect(written.indexPath).toBe(cfg.indexPath);
    expect(written.backupTargets).toEqual(cfg.backupTargets);

    const text = out.join("\n");
    expect(text).toContain("serve");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runInit never overwrites an existing config file", async () => {
  const { cfg, root, write } = makeEnv();
  try {
    const configFile = join(root, "chat-scrobbler.config.json");
    writeFileSync(configFile, JSON.stringify({ canonicalDir: "/custom/canon" }));

    await runInit({ cfg, configFilePath: configFile, write });

    const preserved = JSON.parse(readFileSync(configFile, "utf8"));
    expect(preserved.canonicalDir).toBe("/custom/canon");
    expect(preserved.indexPath).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
