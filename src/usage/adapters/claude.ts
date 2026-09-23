import { UsageAccumulator, finiteNumber, isoDay } from "../aggregate";
import { filesModifiedSince, forEachJsonLine, walkFiles } from "../files";
import { projectFromPath } from "../project";
import type { CollectResult } from "../types";

export interface ClaudeCollectOptions { root: string; device: string; modifiedSinceMs?: number }

interface AssistantUsage {
  timestamp: unknown;
  cwd: string | null;
  model: string;
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  total: number;
}

export async function collectClaudeUsage(options: ClaudeCollectOptions): Promise<CollectResult> {
  const acc = new UsageAccumulator();
  const files = await filesModifiedSince(await walkFiles(options.root, (path) => path.endsWith(".jsonl")), options.modifiedSinceMs);
  let sessions = 0;
  for (const file of files) {
    const messages = new Map<string, AssistantUsage>();
    let firstTimestamp: unknown = null;
    let cwd: string | null = null;
    await forEachJsonLine(file, (row) => {
      firstTimestamp ??= row.timestamp;
      if (typeof row.cwd === "string") cwd = row.cwd;
      if (row.type !== "assistant" || !row.message?.usage) return;
      const usage = row.message.usage;
      const base = finiteNumber(usage.input_tokens);
      const cacheWrite = finiteNumber(usage.cache_creation_input_tokens);
      const cached = finiteNumber(usage.cache_read_input_tokens);
      const output = finiteNumber(usage.output_tokens);
      const item: AssistantUsage = {
        timestamp: row.timestamp,
        cwd: typeof row.cwd === "string" ? row.cwd : cwd,
        model: typeof row.message.model === "string" ? row.message.model : "Unknown model",
        input: base + cacheWrite + cached,
        cached,
        cacheWrite,
        output,
        total: base + cacheWrite + cached + output,
      };
      const id = String(row.message.id ?? row.requestId ?? row.uuid ?? `${row.timestamp}:${messages.size}`);
      const prior = messages.get(id);
      if (!prior || item.total >= prior.total) messages.set(id, item);
    });
    if (firstTimestamp === null && messages.size === 0) continue;
    sessions += 1;
    const firstUsage = messages.values().next().value as AssistantUsage | undefined;
    const base = { source: "claude-code" as const, surface: "Claude Code", device: options.device, project: projectFromPath(cwd), model: firstUsage?.model ?? "Unknown model" };
    acc.add({ ...base, date: isoDay(firstTimestamp), sessions: 1 });
    for (const usage of messages.values()) {
      acc.add({
        ...base, date: isoDay(usage.timestamp), project: projectFromPath(usage.cwd ?? cwd), model: usage.model, messages: 1,
        inputTokens: usage.input, cachedInputTokens: usage.cached, cacheWriteTokens: usage.cacheWrite,
        outputTokens: usage.output, totalTokens: usage.total,
      });
    }
  }
  return {
    buckets: acc.list(),
    coverage: [{ source: "claude-code", status: "exact", detail: "Recorded token counters, sessions, models, and working directories", records: sessions }],
  };
}
