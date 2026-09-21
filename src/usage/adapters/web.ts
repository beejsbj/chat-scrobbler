import { readFile } from "node:fs/promises";
import { UsageAccumulator, isoDay } from "../aggregate";
import { walkFiles } from "../files";
import type { CollectResult, UsageSource } from "../types";

export interface WebCollectOptions { canonicalDir: string; device: string }

const SOURCE_MAP: Record<string, UsageSource> = { chatgpt: "chatgpt", claude: "claude-web", gemini: "gemini-web" };

export async function collectWebUsage(options: WebCollectOptions): Promise<CollectResult> {
  const acc = new UsageAccumulator();
  const files = await walkFiles(options.canonicalDir, (path) => path.endsWith(".json"));
  const counts = new Map<UsageSource, number>();
  for (const file of files) {
    try {
      const session = JSON.parse(await readFile(file, "utf8")) as Record<string, any>;
      const source = SOURCE_MAP[String(session.source)];
      if (!source) continue;
      const messages = Array.isArray(session.messages) ? session.messages : [];
      acc.add({
        date: isoDay(session.created_at ?? session.updated_at), source, surface: source === "chatgpt" ? "ChatGPT web" : source === "claude-web" ? "Claude web" : "Gemini web",
        device: options.device, project: "General chat", model: session.default_model ?? "Unavailable", sessions: 1, messages: messages.length,
      });
      counts.set(source, (counts.get(source) ?? 0) + 1);
    } catch { /* A damaged capture does not block the rest of the archive. */ }
  }
  return {
    buckets: acc.list(),
    coverage: (["chatgpt", "claude-web", "gemini-web"] as UsageSource[]).map((source) => ({
      source,
      status: (counts.get(source) ?? 0) > 0 ? "count-only" : "missing",
      detail: "Captured conversation and message counts; provider web archives do not expose authoritative token totals",
      records: counts.get(source) ?? 0,
    })),
  };
}

