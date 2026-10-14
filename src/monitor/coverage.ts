import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { EmbeddingProvider } from "../indexer/sqlite";
import { validateEmbedding } from "../indexer/embedding-status";

/** Count usable vectors for current text, title, model and dimension. No index migrations. */
export function embeddingCoverage(indexPath: string, provider: EmbeddingProvider | null, since: number, dimension?: number) {
  if (!existsSync(indexPath)) throw new Error("index_missing");
  const db = new Database(indexPath, { readonly: true });
  try {
    db.run("PRAGMA busy_timeout = 5000");
    if ((db.query("PRAGMA quick_check").get() as Record<string, string>).quick_check !== "ok") throw new Error("index_corrupt");
    db.query("SELECT COUNT(*) FROM sessions").get();
    const query = db.query(`SELECT m.created_at, e.embedding, e.provider_kind, e.provider_model, e.dimension,
      e.text = m.text AND e.title IS m.title AS current
      FROM messages_fts m LEFT JOIN message_embeddings e
      ON e.session_id = m.session_id AND e.message_id = m.message_id WHERE trim(m.text) != ''`);
    let withVectors = 0, withoutVectors = 0, recentWith = 0, recentWithout = 0;
    for (const row of query.iterate() as Iterable<{ created_at: string | null; embedding: string | null; provider_kind: string | null; provider_model: string | null; dimension: number | null; current: number }>) {
      let valid = false;
      if (provider && row.current && row.provider_kind === (provider.kind?.trim() || "unknown") && row.provider_model === (provider.model?.trim() || null)) {
        try {
          const vector = validateEmbedding(JSON.parse(row.embedding!));
          valid = vector.length === row.dimension && (dimension == null || vector.length === dimension);
        } catch { /* Invalid vectors do not provide semantic recall. */ }
      }
      if (valid) withVectors++; else withoutVectors++;
      if (row.created_at && Date.parse(row.created_at) >= since) {
        if (valid) recentWith++; else recentWithout++;
      }
    }
    return { with_vectors: withVectors, without_vectors: withoutVectors, recent_with_vectors: recentWith, recent_without_vectors: recentWithout, recent_coverage: recentWith + recentWithout ? recentWith / (recentWith + recentWithout) : 1 };
  } finally { db.close(); }
}
