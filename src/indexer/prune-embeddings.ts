import type { Database } from "bun:sqlite";

export interface PruneScope { kind: string; model: string; }
export interface PruneReport {
  applied: boolean;
  /** The provider and model whose data is kept; null removes every stored vector. */
  keep: PruneScope | null;
  removed: Record<(typeof TABLES)[number]["table"], number>;
}
// Queue state comes first: deleting a vector re-queues its pending row through a trigger.
// The legacy table allows NULL scope columns; everything else is NOT NULL.
const TABLES = [
  { table: "embedding_pending", kind: "provider_kind", model: "provider_model" },
  { table: "embedding_models", kind: "provider_kind", model: "provider_model" },
  { table: "message_vectors", kind: "provider_kind", model: "provider_model" },
  { table: "message_vector_chunks", kind: "provider_kind", model: "provider_model" },
  { table: "message_embeddings", kind: "COALESCE(provider_kind,'')", model: "COALESCE(provider_model,'')" },
  { table: "asset_vectors", kind: "provider_kind", model: "provider_model" },
] as const;

/** Remove stored vectors (and their backfill queue state) that the active provider does not own.
 * Sessions, text and the full text index are untouched; a later provider rebuilds vectors from them.
 * Dry runs count only. The caller holds the backfill lease so no writer races the deletes. */
export function pruneEmbeddings(db: Database, keep: PruneScope | null, opts: { apply: boolean; assertLease?: () => void }): PruneReport {
  const report: PruneReport = { applied: opts.apply, keep, removed: {} as PruneReport["removed"] };
  const run = () => {
    for (const { table, kind, model } of TABLES) {
      const where = keep ? `WHERE NOT (${kind}=? AND ${model}=?)` : "";
      const params = keep ? [keep.kind, keep.model] : [];
      report.removed[table] = opts.apply
        ? db.run(`DELETE FROM ${table} ${where}`, params).changes
        : (db.query(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get(...params) as { n: number }).n;
    }
    opts.assertLease?.(); // A lost lease rolls the whole prune back.
  };
  if (opts.apply) db.transaction(run).immediate(); else run();
  return report;
}
