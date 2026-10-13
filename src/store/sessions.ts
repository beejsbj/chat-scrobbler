// src/store/sessions.ts
import { assertSessionNotDeleted, isSessionDeleted } from "./tombstones";
import { syncDirectory, writeAtomicFile } from "./atomic-file";
import { readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Session, Message } from "../schema/types";
import { assetsDirForSession } from "./assets";

export interface DeleteSessionResult {
  sessionPath: string;
  assetDir: string;
  sessionDeleted: boolean;
  assetsDeleted: boolean;
}

export function writeSession(baseDir: string, session: Session): string {
  const file = sessionFilePath(baseDir, session.source, session.source_id);
  assertSessionNotDeleted(baseDir, session.source, session.source_id);
  writeAtomicFile(file, JSON.stringify(session, null, 2));
  return file;
}

export function readSession(baseDir: string, source: string, sourceId: string): Session {
  assertSessionNotDeleted(baseDir, source, sourceId);
  return JSON.parse(readFileSync(sessionFilePath(baseDir, source, sourceId), "utf8"));
}

export function deleteSession(baseDir: string, source: string, sourceId: string): DeleteSessionResult {
  const sessionPath = sessionFilePath(baseDir, source, sourceId);
  const assetDir = assetsDirForSession(baseDir, source, sourceId);
  const sessionDeleted = existsSync(sessionPath);
  const assetsDeleted = existsSync(assetDir);
  if (sessionDeleted) { rmSync(sessionPath, { force: true }); syncDirectory(join(sessionPath, "..")); }
  if (assetsDeleted) { rmSync(assetDir, { recursive: true, force: true }); syncDirectory(join(assetDir, "..")); }
  return { sessionPath, assetDir, sessionDeleted, assetsDeleted };
}

export function listSessionFiles(baseDir: string): string[] {
  const out: string[] = [];
  if (!existsSync(baseDir)) return out;
  for (const source of readdirSync(baseDir)) {
    const dir = join(baseDir, source);
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const f of entries) if (f.endsWith(".json") && !isSessionDeleted(baseDir, source, f.slice(0, -5))) out.push(join(dir, f));
  }
  return out;
}

/** Return the active branch of a session as an ordered message array.
 *  If active_leaf_id is set and present in messages[], walks parent_id to root
 *  (cycle-safe), reverses, and returns that path. Otherwise returns all messages
 *  unchanged (legacy fallback). */
export function activePath(s: Session): Message[] {
  const leaf = s.active_leaf_id;
  if (!leaf) return s.messages;
  const byId = new Map<string, Message>();
  for (const m of s.messages) byId.set(m.id, m);
  if (!byId.has(leaf)) return s.messages;
  const chain: Message[] = [];
  const seen = new Set<string>();
  let cur: string | null = leaf;
  while (cur !== null && byId.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    chain.push(byId.get(cur)!);
    cur = byId.get(cur)!.parent_id;
  }
  return chain.reverse();
}

export function sessionToMarkdown(s: Session): string {
  const lines: string[] = [`# ${s.title ?? "(untitled)"}`, ``, `*${s.source} · ${s.created_at}*`, ``];
  for (const m of activePath(s)) {
    if (!m.text) continue;
    lines.push(`## ${m.role}`, ``, m.text, ``);
  }
  return lines.join("\n");
}

/** Keep legacy basenames unchanged; reject IDs that cannot be one filename. */
export function sessionFilePath(baseDir: string, source: string, sourceId: string): string {
  if (!["chatgpt", "claude", "gemini"].includes(source)) throw new Error("source is invalid");
  if (!sourceId || sourceId === "." || sourceId === ".." || /[\/\\\x00-\x1f]/.test(sourceId)) throw new Error("source_id is invalid");
  return resolve(baseDir, source, `${sourceId}.json`);
}
