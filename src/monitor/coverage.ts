import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { EmbeddingProvider } from "../indexer/sqlite";
import { validateEmbedding } from "../indexer/embedding-status";
import { decodeVector, textVectorHash } from "../indexer/vector-store";

/** Count usable vectors for current text, title, model and dimension. No index migrations. */
export function embeddingCoverage(indexPath: string, provider: EmbeddingProvider | null, since: number, dimension?: number) {
  if (!existsSync(indexPath)) throw new Error("index_missing");
  const db = new Database(indexPath, { readonly: true });
  try {
    db.run("PRAGMA busy_timeout = 0");
    if ((db.query("PRAGMA quick_check").get() as Record<string, string>).quick_check !== "ok") throw new Error("index_corrupt");
    db.query("SELECT COUNT(*) FROM sessions").get();
    const kind = provider?.kind?.trim() || "unknown", model = provider?.model?.trim() || "";
    const activeDimension = dimension ?? provider?.dimensions ?? null;
    const binaryColumns = db.query("PRAGMA table_info(message_vectors)").all() as Array<{ name: string }>;
    const binary = provider && binaryColumns.length ? db.query(`SELECT embedding, dimension, text,
      ${binaryColumns.some(column => column.name === "text_hash") ? "text_hash" : "NULL AS text_hash"}
      FROM message_vectors WHERE session_id=? AND message_id=? AND provider_kind=? AND provider_model=?
      AND (? IS NULL OR dimension=?) AND title IS ?`) : null;
    const legacy = provider && db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='message_embeddings'").get()
      ? db.query(`SELECT embedding, dimension FROM message_embeddings WHERE session_id=? AND message_id=?
        AND provider_kind=? AND COALESCE(provider_model,'')=? AND (? IS NULL OR dimension=?) AND title IS ? AND text=?`) : null;
    const query = db.query("SELECT session_id, message_id, text, title, created_at FROM messages_fts");
    let withVectors = 0, withoutVectors = 0, recentWith = 0, recentWithout = 0;
    for (const row of query.iterate() as Iterable<{ session_id: string; message_id: string; text: string; title: string | null; created_at: string | null }>) {
      if (!row.text.trim()) continue;
      let valid = false;
      const params = [row.session_id, row.message_id, kind, model, activeDimension, activeDimension, row.title];
      if (binary) {
        const hash = textVectorHash(row.text);
        for (const vector of binary.all(...params) as Array<{ embedding: Uint8Array; dimension: number; text: string; text_hash: string | null }>) {
          if (vector.text_hash !== null ? vector.text_hash !== hash : vector.text !== row.text) continue;
          try { decodeVector(vector.embedding, vector.dimension); valid = true; break; }
          catch { /* Try another matching snapshot or the legacy format. */ }
        }
      }
      if (!valid && legacy) {
        for (const vector of legacy.all(...params, row.text) as Array<{ embedding: string; dimension: number }>) {
          try { valid = validateEmbedding(JSON.parse(vector.embedding)).length === vector.dimension; }
          catch { /* Invalid vectors do not provide semantic recall. */ }
          if (valid) break;
        }
      }
      if (valid) withVectors++; else withoutVectors++;
      if (row.created_at && Date.parse(row.created_at) >= since) {
        if (valid) recentWith++; else recentWithout++;
      }
    }
    return { with_vectors: withVectors, without_vectors: withoutVectors, recent_with_vectors: recentWith, recent_without_vectors: recentWithout, recent_coverage: recentWith + recentWithout ? recentWith / (recentWith + recentWithout) : 1 };
  } finally { db.close(); }
}
