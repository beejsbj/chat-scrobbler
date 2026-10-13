// src/cli/unify.ts
// Rebuilds the SQLite index from canonical session files.
// Refreshes the canonical -> index projection; raw -> canonical reparse is separate.
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Session } from "../schema/types";
import { listSessionFiles } from "../store/sessions";
import { deleteIndexedSession, openIndex, indexSessionWithEmbeddings, type EmbeddingProvider } from "../indexer/sqlite";
import { loadConfig } from "../config";
import { embeddingProviderFromConfig } from "../indexer/embedding-providers";

export interface UnifyOptions { canonicalDir: string; indexPath: string; embeddingProvider?: EmbeddingProvider | null; force?: boolean; embeddingFailureLimit?: number; }

export async function runUnify(opts: UnifyOptions): Promise<number> {
  const canPrune = existsSync(opts.canonicalDir);
  const files = listSessionFiles(opts.canonicalDir);

  mkdirSync(dirname(opts.indexPath), { recursive: true });
  const db = openIndex(opts.indexPath);
  const pruneCandidates = db.query("SELECT id, source, source_id FROM sessions").all() as Array<{ id: string; source: string; source_id: string }>;
  let count = 0;
  const retained = new Set<string>();
  let unreadable = false;
  let consecutiveFailures = 0;
  let circuitOpen = false;
  const failureLimit = opts.embeddingFailureLimit ?? 3;
  if (!Number.isInteger(failureLimit) || failureLimit < 1) { db.close(); throw new Error("embeddingFailureLimit must be a positive integer"); }
  try {
    for (const f of files) {
      let session: Session;
      let snapshot: ReturnType<typeof statSync>;
      try { snapshot = statSync(f); session = JSON.parse(readFileSync(f, "utf8")) as Session; }
      catch { unreadable = true; continue; }
      retained.add(session.id);
      const result = await indexSessionWithEmbeddings(db, session, {
        canonicalDir: opts.canonicalDir,
        embeddingProvider: circuitOpen ? null : opts.embeddingProvider ?? null,
        shouldReplaceEmbeddings: () => {
          try { const current = statSync(f); return current.mtimeMs === snapshot.mtimeMs && current.ino === snapshot.ino && current.size === snapshot.size; }
          catch { return false; }
        },
      });
      if (result === "failed") consecutiveFailures++;
      else if (result !== "disabled") consecutiveFailures = 0;
      if (!circuitOpen && consecutiveFailures >= failureLimit) {
        circuitOpen = true;
        console.error(JSON.stringify({ event: "unify_embedding_circuit_open", consecutive_failures: consecutiveFailures }));
      }
      count++;
    }
    // Refresh in place so failed embedding calls and concurrent readers keep
    // their existing vectors. Prune absent sessions only after a complete read.
    if (canPrune && !unreadable) db.transaction(() => {
      const absent = pruneCandidates.filter(row => !retained.has(row.id) && !existsSync(join(opts.canonicalDir, row.source, `${row.source_id}.json`)));
      if (absent.length && !opts.force && (!files.length || absent.length / pruneCandidates.length > 0.1)) {
        console.error(JSON.stringify({ event: "unify_prune_refused", reason: files.length ? "prune_exceeds_10_percent" : "empty_canonical_store", candidates: absent.length, indexed_sessions: pruneCandidates.length }));
        return;
      }
      for (const row of absent) deleteIndexedSession(db, row.source, row.source_id);
    })();
  } finally { db.close(); }
  return count;
}

if (import.meta.main) {
  const cfg = loadConfig();
  const provider = embeddingProviderFromConfig(cfg);
  const count = await runUnify({ canonicalDir: cfg.canonicalDir, indexPath: cfg.indexPath, embeddingProvider: provider, force: process.argv.includes("--force") });
  const embeddingNote = provider ? ` with ${provider.kind ?? "configured"} embeddings` : "";
  console.log(`Reindexed ${count} sessions from canonical into index${embeddingNote}.`);
}
