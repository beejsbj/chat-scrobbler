// src/indexer/sqlite.ts
import { Database } from "bun:sqlite";
import type { Session } from "../schema/types";
import { activePath } from "../store/sessions";

export interface EmbeddingContext {
  kind: "query" | "document";
  title?: string | null;
}

export interface MessageHit {
  snippet: string; session_id: string; message_id: string;
  role: string; created_at: string | null; source: string; title: string | null;
  provenance: "literal" | "semantic" | "hybrid"; score: number; match_sources: Array<"literal" | "semantic">;
}
export interface SessionSummary {
  id: string; source: string; title: string | null;
  created_at: string; updated_at: string; message_count: number;
}
export interface EmbeddingProvider {
  readonly kind?: string;
  readonly model?: string | null;
  readonly dimensions?: number | null;
  embed(text: string, context?: EmbeddingContext): number[] | Promise<number[]>;
}

export interface IndexSessionOptions { embeddingProvider?: EmbeddingProvider | null; }
export interface SearchMessagesOptions { source?: string; limit?: number; embeddingProvider?: EmbeddingProvider | null; }
export interface DeleteIndexedSessionResult { deleted: boolean; sessionIds: string[]; }

export function openIndex(path: string): Database {
  const db = new Database(path);
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, source TEXT, source_id TEXT, title TEXT,
    created_at TEXT, updated_at TEXT, message_count INTEGER);`);
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    text, message_id UNINDEXED, session_id UNINDEXED, role UNINDEXED,
    created_at UNINDEXED, source UNINDEXED, title UNINDEXED);`);
  db.run(`CREATE TABLE IF NOT EXISTS message_embeddings (
    session_id TEXT NOT NULL, message_id TEXT NOT NULL, embedding TEXT NOT NULL,
    text TEXT NOT NULL, role TEXT, created_at TEXT, source TEXT, title TEXT,
    provider_kind TEXT, provider_model TEXT, dimension INTEGER,
    PRIMARY KEY (session_id, message_id));`);
  migrateMessageEmbeddings(db);
  return db;
}

export function indexSession(db: Database, s: Session, opts: IndexSessionOptions = {}): void {
  const embeddingProvider = opts.embeddingProvider ?? null;
  indexLiteralSession(db, s);
  if (!embeddingProvider) return;

  try {
    replaceEmbeddingRows(db, s.id, collectSyncEmbeddingRows(s, embeddingProvider));
  } catch {
    db.run(`DELETE FROM message_embeddings WHERE session_id = ?`, [s.id]);
  }
}

export async function indexSessionWithEmbeddings(db: Database, s: Session, opts: IndexSessionOptions = {}): Promise<void> {
  const embeddingProvider = opts.embeddingProvider ?? null;
  indexLiteralSession(db, s);
  if (!embeddingProvider) return;

  try {
    replaceEmbeddingRows(db, s.id, await collectAsyncEmbeddingRows(s, embeddingProvider));
  } catch {
    db.run(`DELETE FROM message_embeddings WHERE session_id = ?`, [s.id]);
  }
}

/** Look up the indexed updated_at for given (source, source_id) pairs.
 *  Used by the ingest /status endpoint to answer synced/stale/missing. */
export function indexedConversations(db: Database, source: string, ids: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.query(
    `SELECT source_id, updated_at FROM sessions WHERE source = ? AND source_id IN (${placeholders})`,
  ).all(source, ...ids) as Array<{ source_id: string; updated_at: string }>;
  for (const r of rows) out.set(r.source_id, r.updated_at);
  return out;
}

export function deleteIndexedSession(db: Database, source: string, sourceId: string): DeleteIndexedSessionResult {
  const rows = db.query(
    `SELECT id FROM sessions WHERE source = ? AND source_id = ?`,
  ).all(source, sourceId) as Array<{ id: string }>;
  const sessionIds = rows.length > 0 ? rows.map((row) => row.id) : [`${source}:${sourceId}`];
  for (const sessionId of sessionIds) {
    db.run(`DELETE FROM messages_fts WHERE session_id = ?`, [sessionId]);
    db.run(`DELETE FROM message_embeddings WHERE session_id = ?`, [sessionId]);
    db.run(`DELETE FROM sessions WHERE id = ?`, [sessionId]);
  }
  return { deleted: rows.length > 0, sessionIds };
}

// Quote each term so arbitrary user input can't break FTS5 syntax (terms AND-ed).
function ftsQuery(raw: string): string {
  const terms = raw.trim().split(/\s+/).filter(Boolean).map(t => `"${t.replace(/"/g, '""')}"`);
  return terms.join(" ");
}

export function searchMessages(db: Database, query: string, opts: SearchMessagesOptions = {}): MessageHit[] {
  if (!query.trim()) return [];
  const limit = opts.limit ?? 20;
  const merged = literalHits(db, query, opts.source, limit);

  const semanticProvider = opts.embeddingProvider ?? null;
  if (semanticProvider) {
    const queryEmbedding = safeSyncEmbedding(semanticProvider, query, { kind: "query" });
    if (queryEmbedding) {
      mergeSemanticHits(merged, semanticCandidates(db, queryEmbedding, embeddingMetadata(semanticProvider, queryEmbedding), opts.source, Math.max(limit * 3, 20)), query);
    }
  }

  return finalizeHits(merged, limit);
}

export async function searchMessagesWithEmbeddings(db: Database, query: string, opts: SearchMessagesOptions = {}): Promise<MessageHit[]> {
  if (!query.trim()) return [];
  const limit = opts.limit ?? 20;
  const merged = literalHits(db, query, opts.source, limit);
  const semanticProvider = opts.embeddingProvider ?? null;
  if (semanticProvider) {
    const queryEmbedding = await safeAsyncEmbedding(semanticProvider, query, { kind: "query" });
    if (queryEmbedding) {
      mergeSemanticHits(merged, semanticCandidates(db, queryEmbedding, embeddingMetadata(semanticProvider, queryEmbedding), opts.source, Math.max(limit * 3, 20)), query);
    }
  }
  return finalizeHits(merged, limit);
}

export function listSessions(db: Database, opts: { source?: string; titleContains?: string; limit?: number } = {}): SessionSummary[] {
  const clauses: string[] = [];
  const params: any[] = [];
  if (opts.source) { clauses.push("source = ?"); params.push(opts.source); }
  if (opts.titleContains) {
    clauses.push("title LIKE ? ESCAPE '\\'");
    params.push(`%${opts.titleContains.replace(/[%_\\]/g, "\\$&")}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(opts.limit ?? 50);
  const rows = db.query(
    `SELECT id, source, title, created_at, updated_at, message_count
     FROM sessions ${where} ORDER BY updated_at DESC LIMIT ?`).all(...params) as any[];
  return rows.map(r => ({
    id: r.id, source: r.source, title: r.title,
    created_at: r.created_at, updated_at: r.updated_at, message_count: r.message_count,
  }));
}

interface SemanticRow {
  session_id: string; message_id: string; text: string; role: string;
  created_at: string | null; source: string; title: string | null; similarity: number;
}

interface EmbeddingRow {
  session_id: string; message_id: string; embedding: number[]; text: string; role: string;
  created_at: string | null; source: string; title: string | null;
  provider_kind: string; provider_model: string | null; dimension: number;
}

type RankedHit = MessageHit & { literalRank?: number; semanticRank?: number };

interface EmbeddingMetadata {
  provider_kind: string; provider_model: string | null; dimension: number;
}

function migrateMessageEmbeddings(db: Database): void {
  const columns = new Set(
    (db.query(`PRAGMA table_info(message_embeddings)`).all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
  if (!columns.has("provider_kind")) {
    db.run(`ALTER TABLE message_embeddings ADD COLUMN provider_kind TEXT`);
  }
  if (!columns.has("provider_model")) {
    db.run(`ALTER TABLE message_embeddings ADD COLUMN provider_model TEXT`);
  }
  if (!columns.has("dimension")) {
    db.run(`ALTER TABLE message_embeddings ADD COLUMN dimension INTEGER`);
  }
}

function indexLiteralSession(db: Database, s: Session): void {
  // message_count reflects the active branch only; FTS indexes every message so
  // search can reach text on inactive (edited-away) branches too.
  const activeCount = activePath(s).length;
  db.run(`INSERT OR REPLACE INTO sessions (id, source, source_id, title, created_at, updated_at, message_count)
          VALUES (?,?,?,?,?,?,?)`,
    [s.id, s.source, s.source_id, s.title, s.created_at, s.updated_at, activeCount]);
  db.run(`DELETE FROM messages_fts WHERE session_id = ?`, [s.id]);
  db.run(`DELETE FROM message_embeddings WHERE session_id = ?`, [s.id]);
  const stmt = db.prepare(
    `INSERT INTO messages_fts (text, message_id, session_id, role, created_at, source, title)
     VALUES (?,?,?,?,?,?,?)`);
  for (const m of s.messages) {
    if (!m.text) continue;
    stmt.run(m.text, m.id, s.id, m.role, m.created_at, s.source, s.title);
  }
}

function collectSyncEmbeddingRows(s: Session, provider: EmbeddingProvider): EmbeddingRow[] {
  const rows: EmbeddingRow[] = [];
  for (const m of s.messages) {
    if (!m.text) continue;
    const embedding = syncEmbedding(provider, m.text, { kind: "document", title: s.title });
    rows.push({
      session_id: s.id,
      message_id: m.id,
      embedding,
      text: m.text,
      role: m.role,
      created_at: m.created_at,
      source: s.source,
      title: s.title,
      ...embeddingMetadata(provider, embedding),
    });
  }
  return rows;
}

async function collectAsyncEmbeddingRows(s: Session, provider: EmbeddingProvider): Promise<EmbeddingRow[]> {
  const rows: EmbeddingRow[] = [];
  for (const m of s.messages) {
    if (!m.text) continue;
    const embedding = await provider.embed(m.text, { kind: "document", title: s.title });
    rows.push({
      session_id: s.id,
      message_id: m.id,
      embedding,
      text: m.text,
      role: m.role,
      created_at: m.created_at,
      source: s.source,
      title: s.title,
      ...embeddingMetadata(provider, embedding),
    });
  }
  return rows;
}

function replaceEmbeddingRows(db: Database, sessionId: string, rows: EmbeddingRow[]): void {
  db.run(`DELETE FROM message_embeddings WHERE session_id = ?`, [sessionId]);
  const stmt = db.prepare(
    `INSERT INTO message_embeddings (session_id, message_id, embedding, text, role, created_at, source, title, provider_kind, provider_model, dimension)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  for (const row of rows) {
    stmt.run(
      row.session_id,
      row.message_id,
      JSON.stringify(row.embedding),
      row.text,
      row.role,
      row.created_at,
      row.source,
      row.title,
      row.provider_kind,
      row.provider_model,
      row.dimension,
    );
  }
}

function literalHits(db: Database, query: string, source: string | undefined, limit: number): Map<string, RankedHit> {
  const merged = new Map<string, RankedHit>();
  const params: any[] = [ftsQuery(query)];
  let where = "";
  if (source) { where = "AND source = ?"; params.push(source); }
  params.push(limit);
  const rows = db.query(
    `SELECT snippet(messages_fts, 0, '[', ']', '…', 12) AS snippet,
            message_id, session_id, role, created_at, source, title
     FROM messages_fts WHERE messages_fts MATCH ? ${where}
     ORDER BY rank LIMIT ?`).all(...params) as any[];
  rows.forEach((r, idx) => {
    const key = hitKey(r.session_id, r.message_id);
    merged.set(key, {
      snippet: r.snippet, session_id: r.session_id, message_id: r.message_id,
      role: r.role, created_at: r.created_at, source: r.source, title: r.title,
      provenance: "literal", score: 0, match_sources: ["literal"], literalRank: idx + 1,
    });
  });
  return merged;
}

function mergeSemanticHits(merged: Map<string, RankedHit>, semanticRows: SemanticRow[], query: string): void {
  semanticRows.forEach((r, idx) => {
    const key = hitKey(r.session_id, r.message_id);
    const existing = merged.get(key);
    if (existing) {
      existing.semanticRank = idx + 1;
      existing.provenance = "hybrid";
      existing.match_sources = ["literal", "semantic"];
    } else {
      merged.set(key, {
        snippet: semanticSnippet(r.text, query),
        session_id: r.session_id, message_id: r.message_id,
        role: r.role, created_at: r.created_at, source: r.source, title: r.title,
        provenance: "semantic", score: 0, match_sources: ["semantic"], semanticRank: idx + 1,
      });
    }
  });
}

function finalizeHits(merged: Map<string, RankedHit>, limit: number): MessageHit[] {
  return [...merged.values()]
    .map((hit) => ({ ...hit, score: fusedScore(hit.literalRank, hit.semanticRank) }))
    .sort((a, b) => b.score - a.score || (a.created_at ?? "").localeCompare(b.created_at ?? ""))
    .slice(0, limit)
    .map(({ literalRank, semanticRank, ...hit }) => hit);
}

function semanticCandidates(db: Database, queryEmbedding: number[], metadata: EmbeddingMetadata, source: string | undefined, limit: number): SemanticRow[] {
  const clauses = ["provider_kind = ?", "dimension = ?"];
  const params: any[] = [metadata.provider_kind, metadata.dimension];
  if (metadata.provider_model === null) {
    clauses.push("provider_model IS NULL");
  } else {
    clauses.push("provider_model = ?");
    params.push(metadata.provider_model);
  }
  if (source) {
    clauses.push("source = ?");
    params.push(source);
  }
  const rows = db.query(
    `SELECT session_id, message_id, embedding, text, role, created_at, source, title
     FROM message_embeddings WHERE ${clauses.join(" AND ")}`,
  ).all(...params) as any[];
  return rows
    .map((r) => ({ ...r, similarity: cosine(queryEmbedding, parseEmbedding(r.embedding)) }))
    .filter((r) => r.similarity > 0)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

function fusedScore(literalRank?: number, semanticRank?: number): number {
  const literal = literalRank ? 2 / (literalRank + 1) : 0;
  const semantic = semanticRank ? 1 / (semanticRank + 1) : 0;
  return Number((literal + semantic).toFixed(6));
}

function hitKey(sessionId: string, messageId: string): string {
  return `${sessionId}\0${messageId}`;
}

function semanticSnippet(text: string, query: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= 160) return compact;
  const needle = query.trim().split(/\s+/)[0]?.toLowerCase();
  const idx = needle ? compact.toLowerCase().indexOf(needle) : -1;
  const start = idx > 40 ? idx - 40 : 0;
  return `${start > 0 ? "…" : ""}${compact.slice(start, start + 160)}${start + 160 < compact.length ? "…" : ""}`;
}

function parseEmbedding(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const vector = parsed.map(Number);
    return vector.every(Number.isFinite) ? vector : [];
  } catch {
    return [];
  }
}

function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  const n = a.length;
  let dot = 0, a2 = 0, b2 = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    a2 += a[i] * a[i];
    b2 += b[i] * b[i];
  }
  return a2 && b2 ? dot / (Math.sqrt(a2) * Math.sqrt(b2)) : 0;
}

function embeddingMetadata(provider: EmbeddingProvider, embedding: number[]): EmbeddingMetadata {
  return {
    provider_kind: provider.kind?.trim() || "unknown",
    provider_model: provider.model?.trim() || null,
    dimension: embedding.length,
  };
}

function syncEmbedding(provider: EmbeddingProvider, text: string, context: EmbeddingContext): number[] {
  const result = provider.embed(text, context);
  if (result instanceof Promise) {
    throw new Error(`Embedding provider "${provider.kind ?? "unknown"}" is async; use indexSessionWithEmbeddings/searchMessagesWithEmbeddings`);
  }
  return result;
}

function safeSyncEmbedding(provider: EmbeddingProvider, text: string, context: EmbeddingContext): number[] | null {
  try {
    return syncEmbedding(provider, text, context);
  } catch {
    return null;
  }
}

async function safeAsyncEmbedding(provider: EmbeddingProvider, text: string, context: EmbeddingContext): Promise<number[] | null> {
  try {
    return await provider.embed(text, context);
  } catch {
    return null;
  }
}
