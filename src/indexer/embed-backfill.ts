import type { Database } from "bun:sqlite";
import { loadavg } from "node:os";
import { assetBlobPath } from "../store/assets";
import type { EmbeddingProvider } from "./sqlite";
import { assetCoverage, embedAsset } from "./asset-embeddings";
import { decodeVector, putTextVector, reusableTextVector, vectorScope } from "./vector-store";

export interface BackfillReport {
  event: "progress" | "load_pause" | "complete";
  embedded: number; skipped: number; failed: number; stale: number; attempted: number;
  text: { total: number; embedded: number }; assets: { total: number; embedded: number } | null;
}
interface MessageRow { rowid: number; session_id: string; message_id: string; text: string; title: string|null; role: string; created_at: string|null; source: string; }
export function textCoverage(db: Database, provider: EmbeddingProvider) {
  return db.query(`SELECT COUNT(*) AS total, COALESCE(SUM(EXISTS(SELECT 1 FROM message_vectors v WHERE
    v.session_id=f.session_id AND v.message_id=f.message_id AND v.provider_kind=? AND v.provider_model=? AND (? IS NULL OR v.dimension=?)
    AND v.text=f.text AND v.title IS f.title AND length(v.embedding)=v.dimension*4)
    OR EXISTS(SELECT 1 FROM message_embeddings l WHERE l.session_id=f.session_id AND l.message_id=f.message_id
      AND l.provider_kind=? AND COALESCE(l.provider_model,'')=? AND (? IS NULL OR l.dimension=?)
      AND l.text=f.text AND l.title IS f.title AND CASE WHEN json_valid(l.embedding) THEN json_type(l.embedding)='array' AND json_array_length(l.embedding)=l.dimension ELSE 0 END
      AND NOT EXISTS(SELECT 1 FROM message_vectors v WHERE v.session_id=l.session_id AND v.message_id=l.message_id
        AND v.provider_kind=l.provider_kind AND v.provider_model=COALESCE(l.provider_model,'') AND v.dimension=l.dimension))),0) AS embedded FROM messages_fts f WHERE text<>''`)
    .get(...Array.from({length:2},()=>[provider.kind?.trim() || "unknown",provider.model?.trim() || "",provider.dimensions ?? null,provider.dimensions ?? null]).flat()) as {total:number;embedded:number};
}
export async function embedBackfill(db: Database, opts: {
  provider: EmbeddingProvider; canonicalDir?: string; limit?: number; rate?: number; loadThreshold?: number;
  signal?: AbortSignal; load?: () => number; sleep?: (ms:number)=>Promise<void>;
  progress?: (report: BackfillReport)=>void;
}): Promise<BackfillReport> {
  const {provider,signal} = opts, rate = opts.rate ?? 0.2, threshold = opts.loadThreshold ?? 8;
  if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(threshold) || threshold <= 0 ||
    opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1)) throw new Error("invalid backfill controls");
  if (!provider.kind || !provider.model) throw new Error("backfill requires an explicit provider and model");
  const limit = opts.limit ?? Infinity;
  const sleep = opts.sleep ?? (ms=>new Promise<void>((resolve,reject)=> {
    signal?.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(()=> { signal?.removeEventListener("abort",abort); resolve(); },ms);
    signal?.addEventListener("abort",abort,{once:true});
  }));
  const load = opts.load ?? (()=>loadavg()[0]);
  let embedded=0, skipped=0, failed=0, stale=0, attempted=0;
  const report = (event: BackfillReport["event"]): BackfillReport => ({event,embedded,skipped,failed,stale,attempted,
    text:textCoverage(db,provider),assets:provider.embedAsset ? assetCoverage(db,provider) : null});
  const wait = async () => {
    signal?.throwIfAborted();
    while (load() > threshold) { opts.progress?.(report("load_pause")); await sleep(5000); signal?.throwIfAborted(); }
  };
  const throttle = async () => { await sleep(1000/rate); await wait(); };
  opts.progress?.(report("progress"));
  await wait();
  let cursor = 0;
  while (attempted < limit) {
    const rows = db.query("SELECT rowid,* FROM messages_fts WHERE rowid>? AND text<>'' ORDER BY rowid LIMIT 100").all(cursor) as MessageRow[];
    if (!rows.length) break;
    for (const row of rows) {
      cursor=row.rowid; signal?.throwIfAborted();
      if (reusableTextVector(db,row.session_id,row.message_id,row.text,row.title ?? null,provider,true)) { skipped++; continue; }
      if (attempted >= limit) break;
      await wait();
      const current=db.query("SELECT f.text,f.title FROM message_lookup k JOIN messages_fts f ON f.rowid=k.fts_rowid WHERE k.session_id=? AND k.message_id=?").get(row.session_id,row.message_id) as MessageRow|null;
      if (!current || current.text!==row.text || (current.title ?? null)!==(row.title ?? null)) { stale++; continue; }
      attempted++;
      try {
        const embedding=await provider.embed(row.text,{kind:"document",title:row.title,signal,beforeRequest:wait});
        signal?.throwIfAborted();
        const written=db.transaction(()=> {
          const live=db.query("SELECT f.text,f.title FROM message_lookup k JOIN messages_fts f ON f.rowid=k.fts_rowid WHERE k.session_id=? AND k.message_id=?").get(row.session_id,row.message_id) as MessageRow|null;
          if (!live || live.text!==row.text || (live.title ?? null)!==(row.title ?? null)) return false;
          putTextVector(db,{...row,...vectorScope(provider,embedding.length),embedding}); return true;
        })();
        if (written) embedded++; else stale++;
      } catch { signal?.throwIfAborted(); failed++; }
      // Coverage scans are once per 25 requests, plus start/end and load pauses.
      if (attempted % 25===0) opts.progress?.(report("progress"));
      await throttle();
    }
  }
  if (provider.embedAsset && opts.canonicalDir && attempted < limit) {
    const scope=vectorScope(provider);
    let shaCursor="";
    while (attempted < limit) {
      const rows=db.query("SELECT DISTINCT sha256 FROM asset_embedding_links WHERE sha256>? ORDER BY sha256 LIMIT 100").all(shaCursor) as Array<{sha256:string}>;
      if (!rows.length) break;
      for (const {sha256} of rows) {
        if (attempted>=limit) break;
        shaCursor=sha256;
        const exists=db.query("SELECT embedding FROM asset_vectors WHERE sha256=? AND provider_kind=? AND provider_model=? AND dimension=? AND length(embedding)=dimension*4")
          .get(sha256,scope.provider_kind,scope.provider_model,scope.dimension) as {embedding:Uint8Array}|null;
        if (exists) { try {decodeVector(exists.embedding,scope.dimension);skipped++;continue;} catch { /* Rebuild corruption. */ } }
        await wait(); attempted++;
        try { const result=await embedAsset(db,sha256,assetBlobPath(opts.canonicalDir,sha256),provider,signal);
          if(result==="indexed") embedded++; else if(result==="skipped") skipped++; else stale++;
        } catch { signal?.throwIfAborted(); failed++; }
        if(attempted%25===0) opts.progress?.(report("progress"));
        await throttle();
      }
    }
  }
  const complete=report("complete"); opts.progress?.(complete); return complete;
}
