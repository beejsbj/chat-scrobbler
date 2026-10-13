import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { Database } from "bun:sqlite";
import { assertRawCapture } from "../../packages/shared/src/raw-capture";
import { indexSessionWithEmbeddings, openIndex, type EmbeddingProvider } from "../indexer/sqlite";
import { getParser } from "../parsers/registry";
import type { Session, Source } from "../schema/types";
import { latestRawReference, listRawSessions, SOURCES, type RawIdentity } from "../store/raw-catalog";
import { rawDirForCanonicalDir, readRawCapture } from "../store/raw";
import { listSessionFiles, readSession, sessionFilePath, writeSession } from "../store/sessions";
import { isSessionDeleted } from "../store/tombstones";
import { parseSessionId } from "./session-id";

export interface ReparseOptions {
  canonicalDir: string; indexPath: string; rawDir?: string;
  source?: string; session?: string; dryRun?: boolean;
  embeddingProvider?: EmbeddingProvider | null;
}
export interface ReparseItem {
  id: string; status: "changed" | "unchanged" | "no_raw" | "deleted" | "raced" | "failed";
  reason?: "raw_read_failed" | "canonical_read_failed" | "parse_failed" | "write_failed" | "index_failed";
  canonical_updated?: boolean;
}
export interface ReparseReport {
  dry_run: boolean; changed: number; unchanged: number; no_raw: number; deleted: number; raced: number; failed: number;
  embedding_failures: number; items: ReparseItem[];
}

function identities(opts: ReparseOptions, rawDir: string): RawIdentity[] {
  if (opts.source && !SOURCES.includes(opts.source as Source)) throw new Error("source must be chatgpt, claude or gemini");
  if (opts.session) {
    const parsed = parseSessionId(opts.session);
    if (!parsed.ok) throw new Error("session must be a valid source:source_id");
    if (opts.source && opts.source !== parsed.source) throw new Error("source and session filters disagree");
    return [{ source: parsed.source as Source, source_id: parsed.sourceId }];
  }
  const all = new Map<string, RawIdentity>();
  const canonical = listSessionFiles(opts.canonicalDir).flatMap(file => {
    const source = basename(dirname(file)) as Source;
    return SOURCES.includes(source) ? [{ source, source_id: basename(file, ".json") }] : [];
  });
  for (const item of [...canonical, ...listRawSessions(rawDir)]) {
    if (!opts.source || opts.source === item.source) all.set(`${item.source}:${item.source_id}`, item);
  }
  return [...all.values()].sort((a, b) => `${a.source}:${a.source_id}`.localeCompare(`${b.source}:${b.source_id}`));
}

/** Rebuild only sessions with archived raw; never prune or overwrite on parse failure. */
export async function reparse(opts: ReparseOptions): Promise<ReparseReport> {
  const rawDir = opts.rawDir ?? rawDirForCanonicalDir(opts.canonicalDir);
  const report: ReparseReport = { dry_run: opts.dryRun ?? false, changed: 0, unchanged: 0, no_raw: 0,
    deleted: 0, raced: 0, failed: 0, embedding_failures: 0, items: [] };
  let db: Database | undefined;
  try {
    for (const { source, source_id } of identities(opts, rawDir)) {
      const id = `${source}:${source_id}`;
      const item: ReparseItem = { id, status: "failed" };
      report.items.push(item);
      if (isSessionDeleted(opts.canonicalDir, source, source_id)) { item.status = "deleted"; report.deleted++; continue; }
      let reason: ReparseItem["reason"] = "raw_read_failed";
      try {
        const ref = latestRawReference(rawDir, source, source_id);
        if (!ref) { item.status = "no_raw"; report.no_raw++; continue; }
        const capture = readRawCapture(rawDir, ref);
        assertRawCapture(capture);
        if (capture.source !== source || capture.source_id !== source_id) throw new Error("raw identity mismatch");
        reason = "canonical_read_failed";
        const file = sessionFilePath(opts.canonicalDir, source, source_id);
        const existing = existsSync(file) ? readSession(opts.canonicalDir, source, source_id) : null;
        reason = "parse_failed";
        const sessions = getParser(source, capture.capture_method)(capture, { raw_ref: ref });
        if (sessions.length !== 1 || sessions[0].id !== id || sessions[0].source !== source || sessions[0].source_id !== source_id) {
          throw new Error("parser did not produce the expected session");
        }
        const session: Session = sessions[0];
        if (existing?.messages.length && !session.messages.length) throw new Error("parser lost all messages");
        session.raw_ref = ref;
        // A payload without a title must not erase one recovered from a sidebar.
        session.title ??= existing?.title ?? null;
        if (isSessionDeleted(opts.canonicalDir, source, source_id)) { item.status = "deleted"; report.deleted++; continue; }
        if (latestRawReference(rawDir, source, source_id) !== ref) { item.status = "raced"; report.raced++; continue; }
        if (existing && JSON.stringify(existing) === JSON.stringify(session)) {
          item.status = "unchanged"; report.unchanged++; continue;
        }
        if (!opts.dryRun) {
          reason = "index_failed";
          if (!db) { mkdirSync(dirname(opts.indexPath), { recursive: true }); db = openIndex(opts.indexPath); }
          reason = "write_failed";
          if (isSessionDeleted(opts.canonicalDir, source, source_id)) { item.status = "deleted"; report.deleted++; continue; }
          if (latestRawReference(rawDir, source, source_id) !== ref) { item.status = "raced"; report.raced++; continue; }
          writeSession(opts.canonicalDir, session);
          item.canonical_updated = true;
          if (isSessionDeleted(opts.canonicalDir, source, source_id)) { item.status = "deleted"; report.deleted++; continue; }
          const snapshot = JSON.stringify(session, null, 2);
          reason = "index_failed";
          const result = await indexSessionWithEmbeddings(db, session, {
            embeddingProvider: opts.embeddingProvider,
            canonicalDir: opts.canonicalDir,
            shouldReplaceEmbeddings: () => {
              try { return !isSessionDeleted(opts.canonicalDir, source, source_id) && readFileSync(file, "utf8") === snapshot; }
              catch { return false; }
            },
          });
          if (result === "stale") {
            if (isSessionDeleted(opts.canonicalDir, source, source_id)) { item.status = "deleted"; report.deleted++; }
            else { item.status = "raced"; report.raced++; }
            continue;
          }
          if (result === "failed") report.embedding_failures++;
        }
        item.status = "changed"; report.changed++;
      } catch {
        // Error messages can contain payload data or URLs. Report categories only.
        if (isSessionDeleted(opts.canonicalDir, source, source_id)) { item.status = "deleted"; report.deleted++; }
        else { item.reason = reason; report.failed++; }
      }
    }
  } finally { db?.close(); }
  return report;
}
