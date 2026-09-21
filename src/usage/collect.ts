import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { UsageAccumulator } from "./aggregate";
import { collectClaudeUsage } from "./adapters/claude";
import { collectCodexUsage } from "./adapters/codex";
import { collectCopilotUsage } from "./adapters/copilot";
import { collectCursorUsage } from "./adapters/cursor";
import { collectGeminiUsage } from "./adapters/gemini";
import { collectWebUsage } from "./adapters/web";
import type { CollectResult, UsageSnapshot } from "./types";

export interface LocalUsageOptions {
  device: string;
  home?: string;
  canonicalDir?: string;
  includeWeb?: boolean;
}

export async function collectLocalUsage(options: LocalUsageOptions): Promise<UsageSnapshot> {
  const home = options.home ?? homedir();
  const library = join(home, "Library", "Application Support");
  const results: CollectResult[] = [];
  results.push(await collectCodexUsage({ roots: [join(home, ".codex", "sessions"), join(home, ".codex", "archived_sessions")], device: options.device }));
  results.push(await collectClaudeUsage({ root: join(home, ".claude", "projects"), device: options.device }));
  results.push(collectCursorUsage({ databasePath: join(library, "Cursor", "User", "globalStorage", "state.vscdb"), device: options.device }));
  results.push(await collectCopilotUsage({ workspaceStorageRoot: join(library, "Code", "User", "workspaceStorage"), globalStorageRoot: join(library, "Code", "User", "globalStorage"), device: options.device }));
  results.push(await collectGeminiUsage({ root: join(home, ".gemini", "tmp"), device: options.device }));
  if (options.includeWeb && options.canonicalDir) results.push(await collectWebUsage({ canonicalDir: options.canonicalDir, device: options.device }));
  return combineResults(results, options.device);
}

export async function collectWebSnapshot(canonicalDir: string, device: string): Promise<UsageSnapshot> {
  return combineResults([await collectWebUsage({ canonicalDir, device })], device);
}

function combineResults(results: CollectResult[], device: string): UsageSnapshot {
  const acc = new UsageAccumulator();
  for (const result of results) for (const bucket of result.buckets) acc.add(bucket);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    devices: [device],
    buckets: acc.list(),
    coverage: results.flatMap((result) => result.coverage),
  };
}

export function writeSnapshot(path: string, snapshot: UsageSnapshot): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, JSON.stringify(snapshot, null, 2) + "\n", { mode: 0o600 });
  renameSync(temporary, path);
}

export function defaultSnapshotDir(home = homedir()): string {
  return join(home, ".local", "share", "chat-scrobbler", "usage", "snapshots");
}

