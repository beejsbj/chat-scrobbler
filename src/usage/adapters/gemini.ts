import { UsageAccumulator, isoDay } from "../aggregate";
import { filesModifiedSince, forEachJsonLine, walkFiles } from "../files";
import type { CollectResult } from "../types";

export interface GeminiCollectOptions { root: string; device: string; modifiedSinceMs?: number }

export async function collectGeminiUsage(options: GeminiCollectOptions): Promise<CollectResult> {
  const acc = new UsageAccumulator();
  const files = await filesModifiedSince(await walkFiles(options.root, (path) => /\/chats\/session-[^/]+\.jsonl$/.test(path)), options.modifiedSinceMs);
  let records = 0;
  for (const file of files) {
    let start: unknown = null;
    let messages = 0;
    await forEachJsonLine(file, (row) => {
      start ??= row.startTime ?? row.timestamp;
      const update = row.$set;
      if (Array.isArray(update?.messages)) messages = Math.max(messages, update.messages.length);
    });
    acc.add({
      date: isoDay(start), source: "gemini-cli", surface: "Gemini CLI", device: options.device,
      project: "Unattributed", model: "Unavailable", sessions: 1, messages,
    });
    records += 1;
  }
  return {
    buckets: acc.list(),
    coverage: [{ source: "gemini-cli", status: records ? "count-only" : "missing", detail: "Gemini CLI sessions found locally; authoritative token counters were not retained", records }],
  };
}
