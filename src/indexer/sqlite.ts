// src/indexer/sqlite.ts
import { Database } from "bun:sqlite";
import type { Session } from "../schema/types";
import { activePath } from "../store/sessions";

export interface MessageHit {
  snippet: string; session_id: string; message_id: string;
  role: string; created_at: string | null; source: string; title: string | null;
}
export interface SessionSummary {
  id: string; source: string; title: string | null;
  created_at: string; updated_at: string; message_count: number;
}

export function openIndex(path: string): Database {
  const db = new Database(path);
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, source TEXT, source_id TEXT, title TEXT,
    created_at TEXT, updated_at TEXT, message_count INTEGER);`);
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    text, message_id UNINDEXED, session_id UNINDEXED, role UNINDEXED,
    created_at UNINDEXED, source UNINDEXED, title UNINDEXED);`);
  return db;
}

export function indexSession(db: Database, s: Session): void {
  // message_count reflects the active branch only; FTS indexes every message so
  // search can reach text on inactive (edited-away) branches too.
  const activeCount = activePath(s).length;
  db.run(`INSERT OR REPLACE INTO sessions (id, source, source_id, title, created_at, updated_at, message_count)
          VALUES (?,?,?,?,?,?,?)`,
    [s.id, s.source, s.source_id, s.title, s.created_at, s.updated_at, activeCount]);
  db.run(`DELETE FROM messages_fts WHERE session_id = ?`, [s.id]);
  const stmt = db.prepare(
    `INSERT INTO messages_fts (text, message_id, session_id, role, created_at, source, title)
     VALUES (?,?,?,?,?,?,?)`);
  for (const m of s.messages) {
    if (!m.text) continue;
    stmt.run(m.text, m.id, s.id, m.role, m.created_at, s.source, s.title);
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

// Quote each term so arbitrary user input can't break FTS5 syntax (terms AND-ed).
function ftsQuery(raw: string): string {
  const terms = raw.trim().split(/\s+/).filter(Boolean).map(t => `"${t.replace(/"/g, '""')}"`);
  return terms.join(" ");
}

export function searchMessages(db: Database, query: string, opts: { source?: string; limit?: number } = {}): MessageHit[] {
  if (!query.trim()) return [];
  const limit = opts.limit ?? 20;
  const params: any[] = [ftsQuery(query)];
  let where = "";
  if (opts.source) { where = "AND source = ?"; params.push(opts.source); }
  params.push(limit);
  const rows = db.query(
    `SELECT snippet(messages_fts, 0, '[', ']', '…', 12) AS snippet,
            message_id, session_id, role, created_at, source, title
     FROM messages_fts WHERE messages_fts MATCH ? ${where}
     ORDER BY rank LIMIT ?`).all(...params) as any[];
  return rows.map(r => ({
    snippet: r.snippet, session_id: r.session_id, message_id: r.message_id,
    role: r.role, created_at: r.created_at, source: r.source, title: r.title,
  }));
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
