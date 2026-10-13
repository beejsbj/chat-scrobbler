import type { Database } from "bun:sqlite";
import type { EmbeddingProvider } from "./sqlite";
import { validateEmbedding } from "./embedding-status";
import { createHash } from "node:crypto";

export const textVectorHash = (text: string): string => createHash("sha256").update(text).digest("hex");

export interface VectorScope { provider_kind: string; provider_model: string; dimension: number; }
export interface TextVectorRow extends VectorScope {
  session_id: string; message_id: string; embedding: number[]; text: string;
  role: string; created_at: string | null; source: string; title: string | null;
}

export function vectorScope(provider: EmbeddingProvider, dimension = provider.dimensions): VectorScope {
  if (provider.dimensions && dimension !== provider.dimensions) throw new Error("embedding dimension mismatch");
  if (!dimension || !Number.isInteger(dimension) || dimension < 1) throw new Error("embedding dimension is required");
  return { provider_kind: provider.kind?.trim() || "unknown", provider_model: provider.model?.trim() || "", dimension };
}

// Explicit little-endian float32 is portable across SQLite and phone exports.
export function encodeVector(vector: number[]): Uint8Array {
  validateEmbedding(vector);
  const bytes = new Uint8Array(vector.length * 4);
  const view = new DataView(bytes.buffer);
  vector.forEach((value, index) => {
    view.setFloat32(index * 4, value, true);
    if (!Number.isFinite(view.getFloat32(index * 4, true))) throw new Error("float32 overflow");
  });
  return bytes;
}
export function decodeVector(bytes: Uint8Array, dimension: number): Float32Array {
  if (!Number.isInteger(dimension) || dimension < 1 || !(bytes instanceof Uint8Array) || bytes.byteLength !== dimension * 4) throw new Error("invalid binary vector length");
  // Bun returns an aligned Buffer for blobs; avoid copying during each search.
  const vector = bytes.byteOffset % 4 === 0
    ? new Float32Array(bytes.buffer, bytes.byteOffset, dimension)
    : Float32Array.from({ length: dimension }, (_, i) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat32(i * 4, true));
  if (!vector.every(Number.isFinite)) throw new Error("invalid binary vector");
  return vector;
}
export function createVectorTables(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS message_vectors (
    session_id TEXT NOT NULL, message_id TEXT NOT NULL, provider_kind TEXT NOT NULL,
    provider_model TEXT NOT NULL, dimension INTEGER NOT NULL, embedding BLOB NOT NULL,
    text TEXT NOT NULL, role TEXT, created_at TEXT, source TEXT, title TEXT,
    PRIMARY KEY(session_id,message_id,provider_kind,provider_model,dimension))`);
  db.run(`CREATE INDEX IF NOT EXISTS message_vector_scope ON message_vectors(provider_kind,provider_model,dimension,source)`);
  if (!(db.query("PRAGMA table_info(message_vectors)").all() as Array<{name:string}>).some(c=>c.name==="text_hash"))
    db.run("ALTER TABLE message_vectors ADD COLUMN text_hash TEXT");
  db.run(`CREATE TABLE IF NOT EXISTS vector_migration (name TEXT PRIMARY KEY, cursor INTEGER NOT NULL)`);
  db.run(`CREATE INDEX IF NOT EXISTS legacy_vector_scope ON message_embeddings(provider_kind,provider_model,dimension)`);
}
export function putTextVector(db: Database, row: TextVectorRow): void {
  if (row.embedding.length !== row.dimension) throw new Error("embedding dimension mismatch");
  db.run(`INSERT OR REPLACE INTO message_vectors
    (session_id,message_id,provider_kind,provider_model,dimension,embedding,text,text_hash,role,created_at,source,title)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [row.session_id,row.message_id,row.provider_kind,row.provider_model,row.dimension,
    encodeVector(row.embedding),"",textVectorHash(row.text),row.role,row.created_at,row.source,row.title]);
}
export function reusableBinaryTextVector(db: Database, sessionId: string, messageId: string, text: string, title: string | null, provider: EmbeddingProvider): number[] | null {
  const kind = provider.kind?.trim() || "unknown", model = provider.model?.trim() || "";
  const params = [sessionId,messageId,kind,model,provider.dimensions ?? null,provider.dimensions ?? null,textVectorHash(text),text,title];
  const rows = db.query(`SELECT embedding,dimension FROM message_vectors WHERE session_id=? AND message_id=?
    AND provider_kind=? AND provider_model=? AND (? IS NULL OR dimension=?)
    AND (text_hash=? OR (text_hash IS NULL AND text=?)) AND title IS ? ORDER BY dimension DESC`).all(...params) as Iterable<{embedding:Uint8Array;dimension:number}>;
  for (const row of rows) {
    try { return Array.from(decodeVector(row.embedding,row.dimension)); } catch { /* Try another matching dimension or valid legacy snapshot. */ }
  }
  return null;
}
export function reusableTextVector(db: Database, sessionId: string, messageId: string, text: string, title: string | null, provider: EmbeddingProvider): number[] | null {
  const binary=reusableBinaryTextVector(db,sessionId,messageId,text,title,provider);
  if(binary) return binary;
  const model=provider.model?.trim() || "";
  const params=[sessionId,messageId,provider.kind?.trim() || "unknown",model,provider.dimensions ?? null,provider.dimensions ?? null,text,title];
  const legacy = db.query(`SELECT * FROM message_embeddings WHERE session_id=? AND message_id=?
    AND provider_kind=? AND COALESCE(provider_model,'')=? AND (? IS NULL OR dimension=?) AND text=? AND title IS ?`).get(...params) as any;
  if (!legacy) return null;
  try {
    const vector = validateEmbedding(JSON.parse(legacy.embedding));
    if (vector.length !== legacy.dimension) return null;
    return vector;
  } catch { return null; }
}

/** A stored rowid cursor avoids retrying corrupt legacy rows forever. JSON stays intact. */
export function migrateLegacyVectors(db: Database, opts: { limit?: number } = {}) {
  const limit = opts.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1) throw new Error("migration limit must be a positive integer");
  return db.transaction(() => {
    let cursor = (db.query("SELECT cursor FROM vector_migration WHERE name='json-f32'").get() as any)?.cursor ?? 0;
    let converted = 0, invalid = 0;
    const rows = db.query("SELECT rowid AS cursor,* FROM message_embeddings WHERE rowid>? ORDER BY rowid LIMIT ?").all(cursor, limit) as any[];
    for (const row of rows) {
      cursor = row.cursor;
      try {
        if (!row.provider_kind || !row.dimension) throw new Error("unknown model scope");
        const embedding = validateEmbedding(JSON.parse(row.embedding));
        if (embedding.length !== row.dimension) throw new Error("invalid legacy dimension");
        // Never overwrite a newer binary vector with a historical JSON snapshot.
        const exists = db.query(`SELECT 1 FROM message_vectors WHERE session_id=? AND message_id=? AND provider_kind=? AND provider_model=? AND dimension=?`)
          .get(row.session_id,row.message_id,row.provider_kind,row.provider_model ?? "",row.dimension);
        if (!exists) { putTextVector(db, { ...row, provider_model: row.provider_model ?? "", embedding }); converted++; }
      } catch { invalid++; }
    }
    db.run("INSERT OR REPLACE INTO vector_migration(name,cursor) VALUES ('json-f32',?)", [cursor]);
    return { scanned: rows.length, converted, invalid, cursor };
  })();
}
