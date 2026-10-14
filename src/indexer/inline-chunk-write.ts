import type {Database} from 'bun:sqlite';
import {putTextChunks,textVectorHash,type TextVectorRow} from './vector-store';

/** Caller owns freshness checks and transaction. Existing pending records retain
 * truncation visibility when explicit unify/reparse performs the inference. */
export function putInlineChunks(db:Database,row:TextVectorRow,vectors:number[][],truncated:boolean) {
 putTextChunks(db,row,vectors);
 db.run(`UPDATE embedding_pending SET truncated=?,reason=? WHERE session_id=? AND message_id=?
  AND provider_kind=? AND provider_model=? AND input_hash=? AND title IS ?`,
  [truncated ? 1 : 0,truncated ? 'chunk_limit_truncated' : null,row.session_id,row.message_id,
   row.provider_kind,row.provider_model,textVectorHash(row.text),row.title]);
}
