import type {Database} from 'bun:sqlite';
import type {EmbeddingProvider} from './sqlite';

export const DEFAULT_SKIPPED_RETRY_MS=86_400_000;
export function skippedRetryDelay(cycles:number,baseMs=DEFAULT_SKIPPED_RETRY_MS):number {
 return baseMs*(cycles<=1 ? 1 : cycles===2 ? 3 : 7);
}

/** Caller owns the short transaction and lease fencing. Empty inputs never retry.
 * Older permanent skips have no timestamp: give them the first long delay once.
 * History stays durable so requeued work remains behind fresh pending items. */
export function requeueSkippedEmbeddings(db:Database,provider:EmbeddingProvider,
 opts:{now:number;delayMs?:number;force?:boolean}) {
 const kind=provider.kind!.trim(),model=provider.model!.trim();
 db.run(`UPDATE embedding_pending SET retry_at=?,retry_cycles=MAX(1,retry_cycles)
  WHERE provider_kind=? AND provider_model=? AND state='skipped' AND reason LIKE 'retry_exhausted_%' AND retry_at=0`,
 [opts.now+(opts.delayMs ?? DEFAULT_SKIPPED_RETRY_MS),kind,model]);
 return db.run(`UPDATE embedding_pending SET state='pending',attempts=0,retry_at=0
  WHERE provider_kind=? AND provider_model=? AND state='skipped' AND reason LIKE 'retry_exhausted_%' AND retry_at<=?`,
 [kind,model,opts.force ? Number.MAX_SAFE_INTEGER : opts.now]).changes;
}
