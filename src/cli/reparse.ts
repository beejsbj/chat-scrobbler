import type { ChatHistoryConfig } from "../config";
import { reparse, type ReparseReport } from "../core/reparse";
import { embeddingProviderFromConfig } from "../indexer/embedding-providers";

export async function runReparseCmd(opts: { cfg: ChatHistoryConfig; source?: string; session?: string;
  dryRun?: boolean; json?: boolean; write: (text: string) => void }): Promise<ReparseReport> {
  const report = await reparse({ canonicalDir: opts.cfg.canonicalDir, indexPath: opts.cfg.indexPath,
    source: opts.source, session: opts.session, dryRun: opts.dryRun,
    embeddingProvider: opts.dryRun ? null : embeddingProviderFromConfig(opts.cfg) });
  if (opts.json) opts.write(JSON.stringify(report, null, 2));
  else {
    for (const item of report.items) {
      opts.write(`${item.id}: ${item.status}${item.reason ? ` (${item.reason})` : ""}${item.canonical_updated && item.status === "failed" ? "; canonical updated, run unify to repair index" : ""}`);
    }
    opts.write(`${report.dry_run ? "Would reparse" : "Reparsed"} ${report.changed} session(s); ${report.unchanged} unchanged, ${report.no_raw} without raw, ${report.deleted} deleted, ${report.failed} failed, ${report.embedding_failures} embedding failures.`);
  }
  return report;
}
