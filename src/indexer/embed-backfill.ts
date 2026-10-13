import type { Database } from "bun:sqlite";
import { loadavg } from "node:os";
import { assetBlobPath } from "../store/assets";
import type { EmbeddingProvider } from "./sqlite";
import { assetCoverage, embedAsset } from "./asset-embeddings";
import { decodeVector, putTextVector, reusableBinaryTextVector, reusableTextVector, vectorScope } from "./vector-store";

export interface BackfillReport {
  event: "progress" | "load_pause" | "complete";
  embedded: number; converted: number; skipped: number; failed: number; stale: number; attempted: number;
  coverage_at_attempt: number | null;
  text: { total: number; embedded: number } | null; assets: { total: number; embedded: number } | null;
}
interface MessageRow { rowid: number; session_id: string; message_id: string; text: string; title: string|null; role: string; created_at: string|null; source: string; }
export function textCoverage(db: Database, provider: EmbeddingProvider) {
  const kind=provider.kind?.trim() || "unknown", model=provider.model?.trim() || "", dimension=provider.dimensions ?? null;
  const total=(db.query("SELECT COUNT(*) AS total FROM messages_fts WHERE text<>''").get() as {total:number}).total;
  const covered=new Set<string>();
  for(const row of db.query(`SELECT v.session_id,v.message_id,v.embedding,v.dimension,f.text,f.title FROM message_vectors v
    JOIN message_lookup k ON k.session_id=v.session_id AND k.message_id=v.message_id
    JOIN messages_fts f ON f.rowid=k.fts_rowid WHERE v.provider_kind=? AND v.provider_model=?
    AND (? IS NULL OR v.dimension=?) AND v.text=f.text AND v.title IS f.title`)
    .iterate(kind,model,dimension,dimension) as Iterable<{session_id:string;message_id:string;embedding:Uint8Array;dimension:number;text:string;title:string|null}>) {
    try {decodeVector(row.embedding,row.dimension);covered.add(`${row.session_id}\0${row.message_id}`);}
    catch {if(reusableTextVector(db,row.session_id,row.message_id,row.text,row.title,provider)) covered.add(`${row.session_id}\0${row.message_id}`);}
  }
  for(const row of db.query(`SELECT v.session_id,v.message_id,v.embedding,v.dimension FROM message_embeddings v
    JOIN message_lookup k ON k.session_id=v.session_id AND k.message_id=v.message_id
    JOIN messages_fts f ON f.rowid=k.fts_rowid WHERE v.provider_kind=? AND v.provider_model IS ?
    AND (? IS NULL OR v.dimension=?) AND v.text=f.text AND v.title IS f.title
    AND NOT EXISTS(SELECT 1 FROM message_vectors b WHERE b.session_id=v.session_id AND b.message_id=v.message_id
      AND b.provider_kind=v.provider_kind AND b.provider_model=COALESCE(v.provider_model,'') AND b.dimension=v.dimension
      AND b.text=v.text AND b.title IS v.title)`)
    .iterate(kind,model || null,dimension,dimension) as Iterable<{session_id:string;message_id:string;embedding:string;dimension:number}>) {
    try {const vector=JSON.parse(row.embedding);if(Array.isArray(vector) && vector.length===row.dimension && vector.length>0 && vector.every(value=>typeof value==="number" && Number.isFinite(value))) covered.add(`${row.session_id}\0${row.message_id}`);} catch { /* Invalid legacy vectors do not count. */ }
  }
  return {total,embedded:covered.size};
}
class StaleEmbeddingInput extends Error {}
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
  let embedded=0, converted=0, skipped=0, failed=0, stale=0, attempted=0;
  let coverage: Pick<BackfillReport,"text"|"assets"|"coverage_at_attempt"> = {text:null,assets:null,coverage_at_attempt:null};
  const report = (event: BackfillReport["event"]): BackfillReport => {
    if(event!=="load_pause") coverage={text:textCoverage(db,provider),assets:provider.embedAsset ? assetCoverage(db,provider) : null,coverage_at_attempt:attempted};
    return {event,embedded,converted,skipped,failed,stale,attempted,...coverage};
  };
  const wait = async () => {
    signal?.throwIfAborted();
    while (load() > threshold) { opts.progress?.(report("load_pause")); await sleep(5000); signal?.throwIfAborted(); }
  };
  const throttle = async () => { await sleep(1000/rate); await wait(); };
  await wait();
  opts.progress?.(report("progress"));
  let cursor = 0;
  while (attempted < limit) {
    const rows = db.query("SELECT rowid,* FROM messages_fts WHERE rowid>? AND text<>'' ORDER BY rowid LIMIT 100").all(cursor) as MessageRow[];
    if (!rows.length) break;
    for (const row of rows) {
      cursor=row.rowid; signal?.throwIfAborted();
      if (reusableBinaryTextVector(db,row.session_id,row.message_id,row.text,row.title ?? null,provider)) { skipped++; continue; }
      const cached=reusableTextVector(db,row.session_id,row.message_id,row.text,row.title ?? null,provider);
      if (attempted >= limit) break;
      await wait();
      const current=db.query("SELECT f.text,f.title FROM message_lookup k JOIN messages_fts f ON f.rowid=k.fts_rowid WHERE k.session_id=? AND k.message_id=?").get(row.session_id,row.message_id) as MessageRow|null;
      if (!current || current.text!==row.text || (current.title ?? null)!==(row.title ?? null)) { stale++; continue; }
      attempted++;
      try {
        const beforeRequest=async()=> {
          await wait();
          const live=db.query("SELECT f.text,f.title FROM message_lookup k JOIN messages_fts f ON f.rowid=k.fts_rowid WHERE k.session_id=? AND k.message_id=?").get(row.session_id,row.message_id) as MessageRow|null;
          if(!live || live.text!==row.text || (live.title ?? null)!==(row.title ?? null)) throw new StaleEmbeddingInput();
        };
        const embedding=cached ?? await provider.embed(row.text,{kind:"document",title:row.title,signal,beforeRequest});
        signal?.throwIfAborted();
        const written=db.transaction(()=> {
          const live=db.query("SELECT f.text,f.title FROM message_lookup k JOIN messages_fts f ON f.rowid=k.fts_rowid WHERE k.session_id=? AND k.message_id=?").get(row.session_id,row.message_id) as MessageRow|null;
          if (!live || live.text!==row.text || (live.title ?? null)!==(row.title ?? null)) return false;
          putTextVector(db,{...row,...vectorScope(provider,embedding.length),embedding}); return true;
        })();
        if (written) {if(cached) converted++;else embedded++;} else stale++;
      } catch (error) { signal?.throwIfAborted(); if(error instanceof StaleEmbeddingInput) stale++;else failed++; }
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
