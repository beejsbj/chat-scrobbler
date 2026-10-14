import type {Database} from "bun:sqlite";
import type {EmbeddingProvider} from "./sqlite";
import {ensureMessageLookup} from "./message-lookup";
import {decodeVector,reusableTextVector,textVectorHash} from "./vector-store";
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
    JOIN messages_fts f ON f.rowid=k.fts_rowid AND f.session_id=k.session_id AND f.message_id=k.message_id WHERE v.provider_kind=? AND v.provider_model=?
    AND (? IS NULL OR v.dimension=?) AND (v.text_hash IS NOT NULL OR v.text=f.text) AND v.title IS f.title`)
    .iterate(kind,model,dimension,dimension) as Iterable<{session_id:string;message_id:string;embedding:Uint8Array;dimension:number;text_hash:string|null;text:string;title:string|null}>) {
    if (!row.text.trim()) continue;
    if (row.text_hash !== null && row.text_hash !== textVectorHash(row.text)) continue;
    try {decodeVector(row.embedding,row.dimension);covered.add(`${row.session_id}\0${row.message_id}`);}
    catch {if(reusableTextVector(db,row.session_id,row.message_id,row.text,row.title,provider)) covered.add(`${row.session_id}\0${row.message_id}`);}
  }
  for(const row of db.query(`SELECT v.session_id,v.message_id,v.embedding,v.dimension,f.text FROM message_embeddings v
    JOIN message_lookup k ON k.session_id=v.session_id AND k.message_id=v.message_id
    JOIN messages_fts f ON f.rowid=k.fts_rowid AND f.session_id=k.session_id AND f.message_id=k.message_id WHERE v.provider_kind=? AND v.provider_model IS ?
    AND (? IS NULL OR v.dimension=?) AND v.text=f.text AND v.title IS f.title`)
    .iterate(kind,model || null,dimension,dimension) as Iterable<{session_id:string;message_id:string;embedding:string;dimension:number;text:string}>) {
    if (!row.text.trim()) continue;
    try {const vector=JSON.parse(row.embedding);if(Array.isArray(vector) && vector.length===row.dimension && vector.length>0 && vector.every(value=>typeof value==="number" && Number.isFinite(value))) covered.add(`${row.session_id}\0${row.message_id}`);} catch { /* Invalid legacy vectors do not count. */ }
  }
  return {total,embedded:covered.size};
}
