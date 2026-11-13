import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import type { ChatHistoryConfig } from "../config";
import { acquireBackfillLock, readBackfillLease } from "../indexer/backfill-lock";
import { embeddingProviderFromConfig } from "../indexer/embedding-providers";
import { openIndex } from "../indexer/sqlite";
import { pruneEmbeddings } from "../indexer/prune-embeddings";

export async function runPruneEmbeddings(args: string[], cfg: ChatHistoryConfig, write: (line: string) => void): Promise<void> {
  const { values } = parseArgs({ args, options: { apply: { type: "boolean", default: false }, json: { type: "boolean", default: false } } });
  // openIndex creates a missing file, which would make a mistyped path look like an empty index.
  if (!existsSync(cfg.indexPath)) throw new Error(`index not found at ${cfg.indexPath}`);
  const provider = embeddingProviderFromConfig(cfg);
  if (provider && (!provider.kind || !provider.model)) throw new Error("prune-embeddings needs an explicit provider and model");
  const lock = acquireBackfillLock(cfg.indexPath);
  if (!lock) {
    write(JSON.stringify({ event: "lease_busy", lease: readBackfillLease(cfg.indexPath) }));
    throw new Error("backfill already running for this index");
  }
  let db: ReturnType<typeof openIndex> | undefined;
  try {
    db = openIndex(cfg.indexPath);
    const report = pruneEmbeddings(db, provider ? { kind: provider.kind!.trim(), model: provider.model!.trim() } : null, { apply: values.apply, assertLease: () => lock.assertOwned(db!) });
    if (values.json) { write(JSON.stringify(report)); return; }
    const kept = report.keep ? `keeping ${report.keep.kind}/${report.keep.model}` : "no embedding provider configured, keeping nothing";
    write(`${report.applied ? "Removed" : "Would remove"} (${kept}):`);
    for (const [table, n] of Object.entries(report.removed)) write(`  ${table}: ${n}`);
    if (!report.applied) write("Dry run. Re-run with --apply to delete.");
  } finally {
    try { db?.close(); } finally { lock.release(); }
  }
}
