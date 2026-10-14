import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { EmbeddingProvider } from "../indexer/sqlite";

/** Observe persisted skips, including scheduled retries, without initializing the queue. */
export function skippedEmbeddingFailure(indexPath?: string, provider?: EmbeddingProvider | null): string | null {
  if (!indexPath || !provider || !existsSync(indexPath)) return null;
  const db = new Database(indexPath, { readonly: true });
  try {
    db.run("PRAGMA busy_timeout = 0");
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='embedding_pending'").get()) return null;
    const rows = db.query(`SELECT reason, COUNT(*) AS n FROM embedding_pending
      WHERE provider_kind=? AND provider_model=? AND state='skipped' AND COALESCE(reason,'')!='empty_text'
      GROUP BY reason ORDER BY n DESC, reason ASC`).all(provider.kind?.trim() || "unknown", provider.model?.trim() || "") as Array<{ reason: string | null; n: number }>;
    if (!rows.length) return null;
    // An old or malformed queue may contain arbitrary errors. Emit only known categories.
    const reason = rows[0].reason;
    const safe = reason && /^(retry_exhausted_)?(request_timeout|connection_unavailable|item_error|http_[1-5]\d{2})$/.test(reason) ? reason : "unknown";
    return `FAILED embeddings skipped=${rows.reduce((sum, row) => sum + row.n, 0)} reason=${safe}`;
  } finally { db.close(); }
}
