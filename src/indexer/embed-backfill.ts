import type { Database } from "bun:sqlite";
import { loadavg } from "node:os";
import { assetBlobPath } from "../store/assets";
import type { EmbeddingProvider } from "./sqlite";
import { assetCoverage, embedAsset } from "./asset-embeddings";
import { ensureMessageLookup } from "./message-lookup";
import { decodeVector, putTextVector, reusableBinaryTextVector, reusableTextVector, textVectorHash, vectorScope } from "./vector-store";

export interface BackfillReport {
  event: "progress" | "load_pause" | "complete";
  embedded: number; converted: number; skipped: number; failed: number; stale: number; attempted: number;
  coverage_at_attempt: number | null;
  text: { total: number; embedded: number } | null; assets: { total: number; embedded: number } | null;
}
interface MessageRow { rowid: number; session_id: string; message_id: string; text: string; title: string|null; role: string; created_at: string|null; source: string; }
export function textCoverage(db: Database, provider: EmbeddingProvider) {
  ensureMessageLookup(db);
  const kind=provider.kind?.trim() || "unknown", model=provider.model?.trim() || "", dimension=provider.dimensions ?? null;
  let total=0;
  for (const row of db.query("SELECT text FROM messages_fts").iterate() as Iterable<{text:string}>) {
    if (row.text.trim()) total++;
  }
  const covered=new Set<string>();
  for(const row of db.query(`SELECT v.session_id,v.message_id,v.embedding,v.dimension,v.text_hash,f.text,f.title FROM message_vectors v
    JOIN message_lookup k ON k.session_id=v.session_id AND k.message_id=v.message_id
    JOIN messages_fts f ON f.rowid=k.fts_rowid WHERE v.provider_kind=? AND v.provider_model=?
    AND (? IS NULL OR v.dimension=?) AND (v.text_hash IS NOT NULL OR v.text=f.text) AND v.title IS f.title`)
    .iterate(kind,model,dimension,dimension) as Iterable<{session_id:string;message_id:string;embedding:Uint8Array;dimension:number;text_hash:string|null;text:string;title:string|null}>) {
    if (!row.text.trim()) continue;
    if (row.text_hash !== null && row.text_hash !== textVectorHash(row.text)) continue;
    try {decodeVector(row.embedding,row.dimension);covered.add(`${row.session_id}\0${row.message_id}`);}
    catch {if(reusableTextVector(db,row.session_id,row.message_id,row.text,row.title,provider)) covered.add(`${row.session_id}\0${row.message_id}`);}
  }
  for(const row of db.query(`SELECT v.session_id,v.message_id,v.embedding,v.dimension,f.text FROM message_embeddings v
    JOIN message_lookup k ON k.session_id=v.session_id AND k.message_id=v.message_id
    JOIN messages_fts f ON f.rowid=k.fts_rowid WHERE v.provider_kind=? AND v.provider_model IS ?
    AND (? IS NULL OR v.dimension=?) AND v.text=f.text AND v.title IS f.title`)
    .iterate(kind,model || null,dimension,dimension) as Iterable<{session_id:string;message_id:string;embedding:string;dimension:number;text:string}>) {
    if (!row.text.trim()) continue;
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
  const {provider,signal} = opts, rate = opts.rate ?? 10, threshold = opts.loadThreshold;
  if (!Number.isFinite(rate) || rate <= 0 || threshold !== undefined && (!Number.isFinite(threshold) || threshold <= 0) ||
    opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1)) throw new Error("invalid backfill controls");
  if (!provider.kind || !provider.model) throw new Error("backfill requires an explicit provider and model");
  ensureMessageLookup(db);
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
    while (threshold !== undefined && load() > threshold) { opts.progress?.(report("load_pause")); await sleep(5000); signal?.throwIfAborted(); }
  };
  let needsPacing = false;
  const throttle = async () => {
    if (needsPacing) { await sleep(1000/rate); needsPacing=false; }
    await wait();
  };
  await wait();
  opts.progress?.(report("progress"));
  let cursor = 0;
  while (attempted < limit) {
    const rows = db.query("SELECT rowid,* FROM messages_fts WHERE rowid>? ORDER BY rowid LIMIT 100").all(cursor) as MessageRow[];
    if (!rows.length) break;
    for (const row of rows) {
      cursor=row.rowid; signal?.throwIfAborted();
      if (!row.text.trim()) { skipped++; continue; }
      if (reusableBinaryTextVector(db,row.session_id,row.message_id,row.text,row.title ?? null,provider)) { skipped++; continue; }
      const cached=reusableTextVector(db,row.session_id,row.message_id,row.text,row.title ?? null,provider);
      if (attempted >= limit) break;
      await wait();
      const current=db.query("SELECT f.text,f.title FROM message_lookup k JOIN messages_fts f ON f.rowid=k.fts_rowid WHERE k.session_id=? AND k.message_id=?").get(row.session_id,row.message_id) as MessageRow|null;
      if (!current || current.text!==row.text || (current.title ?? null)!==(row.title ?? null)) { stale++; continue; }
      attempted++;
      try {
        const checkCurrent=()=> {
          const live=db.query("SELECT f.text,f.title FROM message_lookup k JOIN messages_fts f ON f.rowid=k.fts_rowid WHERE k.session_id=? AND k.message_id=?").get(row.session_id,row.message_id) as MessageRow|null;
          if(!live || live.text!==row.text || (live.title ?? null)!==(row.title ?? null)) throw new StaleEmbeddingInput();
        };
        const beforeRequest=async()=> { await throttle(); checkCurrent(); needsPacing=true; };
        let firstHook=true;
        if (!cached) await beforeRequest();
        const embedding=cached ?? await provider.embed(row.text,{kind:"document",title:row.title,signal,beforeRequest:async()=> {
          if (firstHook) { firstHook=false; await wait(); checkCurrent(); }
          else await beforeRequest();
        }});
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
        await throttle(); attempted++; needsPacing=true;
        try { const result=await embedAsset(db,sha256,assetBlobPath(opts.canonicalDir,sha256),provider,signal);
          if(result==="indexed") embedded++; else if(result==="skipped") skipped++; else stale++;
        } catch { signal?.throwIfAborted(); failed++; }
        if(attempted%25===0) opts.progress?.(report("progress"));
      }
    }
  }
  const complete=report("complete"); opts.progress?.(complete); return complete;
}
