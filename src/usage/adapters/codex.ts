import { UsageAccumulator, finiteNumber, isoDay } from "../aggregate";
import { forEachJsonLine, newestUniqueRollouts } from "../files";
import { projectFromPath } from "../project";
import type { CollectResult } from "../types";

export interface CodexCollectOptions { roots: string[]; device: string; modifiedSinceMs?: number }

function surface(meta: Record<string, any>): string {
  const value = `${meta.originator ?? ""} ${meta.source ?? ""}`.toLowerCase();
  if (value.includes("t3")) return "T3 Code";
  if (value.includes("vscode")) return "VS Code";
  if (value.includes("desktop")) return "Codex Desktop";
  return "Codex";
}

export async function collectCodexUsage(options: CodexCollectOptions): Promise<CollectResult> {
  const acc = new UsageAccumulator();
  const files = (await newestUniqueRollouts(options.roots)).filter((path) => {
    if (options.modifiedSinceMs === undefined) return true;
    try { return Bun.file(path).lastModified >= options.modifiedSinceMs; } catch { return false; }
  });
  let sessions = 0;
  for (const file of files) {
    let meta: Record<string, any> = {};
    let model = "Unknown model";
    let started = "Unknown";
    let sessionAdded = false;
    let previous = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 };

    await forEachJsonLine(file, (row) => {
      if (row.type === "session_meta" && row.payload) {
        meta = row.payload;
        started = isoDay(row.payload.timestamp ?? row.timestamp);
        return;
      }
      if (row.type === "turn_context" && typeof row.payload?.model === "string") model = row.payload.model;
      const common = () => ({
        date: isoDay(row.timestamp, started), source: "codex" as const, surface: surface(meta), device: options.device,
        project: projectFromPath(meta.cwd), model,
      });
      if (!sessionAdded && Object.keys(meta).length > 0) {
        acc.add({ ...common(), date: started, sessions: 1 });
        sessionAdded = true;
        sessions += 1;
      }
      if (row.type === "response_item" && row.payload?.type === "message" && ["user", "assistant"].includes(row.payload?.role)) {
        acc.add({ ...common(), messages: 1 });
      }
      if (row.type !== "event_msg" || row.payload?.type !== "token_count") return;
      const usage = row.payload?.info?.total_token_usage;
      if (!usage) return;
      const current = {
        input: finiteNumber(usage.input_tokens),
        cached: finiteNumber(usage.cached_input_tokens),
        cacheWrite: finiteNumber(usage.cache_write_input_tokens),
        output: finiteNumber(usage.output_tokens),
        reasoning: finiteNumber(usage.reasoning_output_tokens),
        total: finiteNumber(usage.total_tokens),
      };
      const delta = (key: keyof typeof current) => Math.max(0, current[key] - previous[key]);
      acc.add({
        ...common(), inputTokens: delta("input"), cachedInputTokens: delta("cached"), cacheWriteTokens: delta("cacheWrite"),
        outputTokens: delta("output"), reasoningTokens: delta("reasoning"), totalTokens: delta("total"),
      });
      previous = current;
    });
  }
  return {
    buckets: acc.list(),
    coverage: [{ source: "codex", status: "exact", detail: "Recorded token counters, sessions, models, and working directories", records: sessions }],
  };
}
