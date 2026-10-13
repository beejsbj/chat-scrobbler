import type { ChatHistoryConfig } from "../config";
import { embeddingProviderFromConfig } from "../indexer/embedding-providers";
import type { EmbeddingProvider } from "../indexer/sqlite";
import { monitorReport } from "../monitor/report";

/** Cron convention: categorical output only, including unexpected failures; exit remains zero. */
export async function runMonitorCmd(cfg: ChatHistoryConfig, write: (line: string) => void, ack = false): Promise<void> {
  try {
    let provider: EmbeddingProvider | null = null;
    try { provider = embeddingProviderFromConfig(cfg); }
    catch {
      provider = { kind: cfg.embeddingProvider, model: cfg.embeddingModel ?? undefined, embed() { throw new Error("embedding_unavailable"); } };
    }
    const report = await monitorReport({ ...cfg, embeddingProvider: provider }, ack);
    for (const failure of report.failures) write(failure);
  } catch { write("FAILED monitor report_unavailable"); }
}
