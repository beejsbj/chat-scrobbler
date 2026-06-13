// src/store/sessions.ts
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Session, Message } from "../schema/types";

export function writeSession(baseDir: string, session: Session): string {
  const dir = join(baseDir, session.source);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${session.source_id}.json`);
  writeFileSync(file, JSON.stringify(session, null, 2));
  return file;
}

export function readSession(baseDir: string, source: string, sourceId: string): Session {
  return JSON.parse(readFileSync(join(baseDir, source, `${sourceId}.json`), "utf8"));
}

export function listSessionFiles(baseDir: string): string[] {
  const out: string[] = [];
  if (!existsSync(baseDir)) return out;
  for (const source of readdirSync(baseDir)) {
    const dir = join(baseDir, source);
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const f of entries) if (f.endsWith(".json")) out.push(join(dir, f));
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
