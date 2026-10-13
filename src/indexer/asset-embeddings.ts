import type { Database } from "bun:sqlite";
import type { Session } from "../schema/types";
import type { EmbeddingProvider } from "./sqlite";
import { decodeVector, encodeVector, vectorScope } from "./vector-store";
import { cosine } from "./vector-math";

export function createAssetVectorTables(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS asset_vectors (sha256 TEXT NOT NULL, provider_kind TEXT NOT NULL,
    provider_model TEXT NOT NULL, dimension INTEGER NOT NULL, embedding BLOB NOT NULL,
    PRIMARY KEY(sha256,provider_kind,provider_model,dimension))`);
  db.run(`CREATE INDEX IF NOT EXISTS asset_vector_scope ON asset_vectors(provider_kind,provider_model,dimension)`);
  db.run(`CREATE TABLE IF NOT EXISTS asset_embedding_links (sha256 TEXT NOT NULL, session_id TEXT NOT NULL,
    message_id TEXT NOT NULL, media_type TEXT NOT NULL, text TEXT NOT NULL, role TEXT, created_at TEXT, source TEXT, title TEXT,
    PRIMARY KEY(sha256,session_id,message_id))`);
  db.run(`CREATE INDEX IF NOT EXISTS asset_link_session ON asset_embedding_links(session_id)`);
}
export function pruneUnownedAssetVectors(db: Database, hashes: string[]): void {
  for (const sha of hashes) db.run("DELETE FROM asset_vectors WHERE sha256=? AND NOT EXISTS(SELECT 1 FROM asset_embedding_links l WHERE l.sha256=asset_vectors.sha256)", [sha]);
}
export function linkedAssetHashes(db: Database, sessionId: string): string[] {
  return (db.query("SELECT DISTINCT sha256 FROM asset_embedding_links WHERE session_id=?").all(sessionId) as Array<{sha256:string}>).map(row=>row.sha256);
}
// No schema/parser edits: sha256 already exists on attachment blocks. Video is a
// forward-compatible hook for BJS-547 and legacy file attachments with a video name.
export function replaceAssetLinks(db: Database, session: Session): void {
  const previous=linkedAssetHashes(db,session.id);
  db.run("DELETE FROM asset_embedding_links WHERE session_id=?", [session.id]);
  for (const message of session.messages) for (const block of message.blocks) {
    if (block.type !== "attachment" || !block.sha256 || !/^[a-f0-9]{64}$/.test(block.sha256)) continue;
    const kind = String(block.kind);
    const media = kind === "image" || kind === "audio" || kind === "video" ? kind
      : /\.(mp4|webm|mov|mkv)$/i.test(block.filename ?? "") ? "video" : null;
    if (!media) continue;
    db.run(`INSERT OR REPLACE INTO asset_embedding_links(sha256,session_id,message_id,media_type,text,role,created_at,source,title)
      VALUES (?,?,?,?,?,?,?,?,?)`, [block.sha256,session.id,message.id,media,message.text,message.role,message.created_at,session.source,session.title]);
  }
  pruneUnownedAssetVectors(db,previous);
}
export function assetCoverage(db: Database, provider: EmbeddingProvider) {
  const scope = vectorScope(provider);
  const total=(db.query("SELECT COUNT(DISTINCT sha256) AS total FROM asset_embedding_links").get() as {total:number}).total;
  let embedded=0;
  for(const row of db.query(`SELECT embedding FROM asset_vectors v WHERE provider_kind=? AND provider_model=? AND dimension=?
    AND EXISTS(SELECT 1 FROM asset_embedding_links l WHERE l.sha256=v.sha256)`)
    .iterate(scope.provider_kind,scope.provider_model,scope.dimension) as Iterable<{embedding:Uint8Array}>) {
    try { decodeVector(row.embedding,scope.dimension); embedded++; } catch { /* Coverage excludes corrupt derived data. */ }
  }
  return {total,embedded};
}
export async function embedAsset(db: Database, sha256: string, path: string, provider: EmbeddingProvider, signal?: AbortSignal): Promise<"indexed"|"skipped"|"stale"> {
  if (!provider.embedAsset) throw new Error("provider has no multimodal support");
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("invalid asset hash");
  const scope = vectorScope(provider);
  const link = db.query("SELECT media_type FROM asset_embedding_links WHERE sha256=? LIMIT 1").get(sha256) as {media_type: "image"|"audio"|"video"} | null;
  if (!link) return "stale";
  const existing = db.query("SELECT embedding FROM asset_vectors WHERE sha256=? AND provider_kind=? AND provider_model=? AND dimension=?")
    .get(sha256,scope.provider_kind,scope.provider_model,scope.dimension) as {embedding: Uint8Array} | null;
  if (existing) { try { decodeVector(existing.embedding,scope.dimension); return "skipped"; } catch { /* rebuild */ } }
  const embedding = encodeVector(await provider.embedAsset({ type: link.media_type, path }, { kind: "document", signal }));
  if (embedding.byteLength !== scope.dimension * 4) throw new Error("asset embedding dimension mismatch");
  signal?.throwIfAborted();
  return db.transaction(() => {
    if (!db.query("SELECT 1 FROM asset_embedding_links WHERE sha256=?").get(sha256)) return "stale" as const;
    db.run("INSERT OR REPLACE INTO asset_vectors(sha256,provider_kind,provider_model,dimension,embedding) VALUES (?,?,?,?,?)",
      [sha256,scope.provider_kind,scope.provider_model,scope.dimension,embedding]);
    return "indexed" as const;
  })();
}
export function assetSemanticCandidates(db: Database, query: number[], scope: {provider_kind:string;provider_model:string|null;dimension:number}, source: string | undefined, limit: number) {
  const params = [scope.provider_kind,scope.provider_model ?? "",scope.dimension,...(source ? [source] : [])];
  const sourceWhere = source ? " AND EXISTS(SELECT 1 FROM asset_embedding_links l WHERE l.sha256=v.sha256 AND l.source=?)" : "";
  const ranked: Array<{sha256:string;similarity:number}> = [];
  for (const row of db.query(`SELECT sha256,embedding FROM asset_vectors v WHERE provider_kind=? AND provider_model=? AND dimension=?${sourceWhere}`).iterate(...params) as Iterable<{sha256:string;embedding:Uint8Array}>) {
    let similarity: number;
    try { similarity = cosine(query,decodeVector(row.embedding,scope.dimension)); } catch { continue; }
    if (similarity <= 0 || ranked.length >= limit && similarity <= ranked[ranked.length-1].similarity) continue;
    ranked.push({ sha256:row.sha256,similarity }); ranked.sort((a,b)=>b.similarity-a.similarity); if(ranked.length>limit) ranked.pop();
  }
  // Bound output even if one shared asset has thousands of owners.
  return ranked.flatMap(row => (db.query(`SELECT session_id,message_id,text,role,created_at,source,title FROM asset_embedding_links WHERE sha256=?${source ? " AND source=?" : ""} ORDER BY session_id,message_id LIMIT ?`)
    .all(row.sha256,...(source ? [source] : []),limit) as Array<{session_id:string;message_id:string;text:string;role:string;created_at:string|null;source:string;title:string|null}>)
    .map(link=>({ ...link,text: link.text || "[Media attachment]",similarity:row.similarity })));
}
