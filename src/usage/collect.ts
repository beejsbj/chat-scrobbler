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
  modifiedSinceMs?: number;
}

export async function collectLocalUsage(options: LocalUsageOptions): Promise<UsageSnapshot> {
  const home = options.home ?? homedir();
  const library = join(home, "Library", "Application Support");
  const results: CollectResult[] = [];
  results.push(await collectCodexUsage({ roots: [join(home, ".codex", "sessions"), join(home, ".codex", "archived_sessions")], device: options.device, modifiedSinceMs: options.modifiedSinceMs }));
  results.push(await collectClaudeUsage({ root: join(home, ".claude", "projects"), device: options.device, modifiedSinceMs: options.modifiedSinceMs }));
  results.push(collectCursorUsage({ databasePath: join(library, "Cursor", "User", "globalStorage", "state.vscdb"), device: options.device }));
  results.push(await collectCopilotUsage({ workspaceStorageRoot: join(library, "Code", "User", "workspaceStorage"), globalStorageRoot: join(library, "Code", "User", "globalStorage"), device: options.device, modifiedSinceMs: options.modifiedSinceMs }));
  results.push(await collectGeminiUsage({ root: join(home, ".gemini", "tmp"), device: options.device, modifiedSinceMs: options.modifiedSinceMs }));
  if (options.includeWeb && options.canonicalDir) results.push(await collectWebUsage({ canonicalDir: options.canonicalDir, device: options.device, modifiedSinceMs: options.modifiedSinceMs }));
  return combineResults(results, options.device);
}

export async function collectWebSnapshot(canonicalDir: string, device: string, modifiedSinceMs?: number): Promise<UsageSnapshot> {
  return combineResults([await collectWebUsage({ canonicalDir, device, modifiedSinceMs })], device);
}

export function mergeRecentSnapshot(existing: UsageSnapshot, recent: UsageSnapshot, cutoffDay: string): UsageSnapshot {
  const acc = new UsageAccumulator();
  for (const bucket of existing.buckets) if (bucket.date < cutoffDay) acc.add(bucket);
  for (const bucket of recent.buckets) if (bucket.date >= cutoffDay) acc.add(bucket);
  const buckets = acc.list();
  const details = new Map(existing.coverage.map((item) => [item.source, item]));
  for (const item of recent.coverage) {
    const prior = details.get(item.source);
    if (!prior || item.status !== "missing") details.set(item.source, item);
  }
  const records = new Map<string, number>();
  for (const bucket of buckets) records.set(bucket.source, (records.get(bucket.source) ?? 0) + bucket.sessions);
  const coverage = [...details.values()].map((item) => {
    const count = records.get(item.source) ?? 0;
    const status = count > 0 && item.status === "missing"
      ? (["codex", "claude-code"].includes(item.source) ? "exact" : "count-only")
      : item.status;
    return { ...item, status, records: count };
  });
  return {
    schemaVersion: 1,
    generatedAt: recent.generatedAt,
    devices: [...new Set([...existing.devices, ...recent.devices])].sort(),
    buckets,
    coverage: coverage.sort((a, b) => a.source.localeCompare(b.source)),
  };
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
