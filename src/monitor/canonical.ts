import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { listSessionFiles } from "../store/sessions";
import type { Session } from "../schema/types";
import { SOURCES } from "../store/raw-catalog";

export function canonicalObservations(canonicalDir: string, since: number) {
  let missingAssets = 0, unreadable = 0;
  const latest: Partial<Record<Session["source"], string>> = {};
  const root = resolve(dirname(canonicalDir));
  for (const file of listSessionFiles(canonicalDir)) {
    try {
      const session = JSON.parse(readFileSync(file, "utf8")) as Session;
      if (!Array.isArray(session.messages)) throw new Error("invalid session");
      const updated = Date.parse(session.updated_at);
      if (SOURCES.includes(session.source) && Number.isFinite(updated)) {
        const time = new Date(updated).toISOString();
        if (!latest[session.source] || time > latest[session.source]!) latest[session.source] = time;
      }
      // Rebuilds change file times, not conversation activity.
      const activity = Math.max(Date.parse(session.updated_at) || 0, ...session.messages.map(message => Date.parse(message.created_at ?? "") || 0));
      const recent = activity >= since;
      for (const message of session.messages) for (const block of message.blocks) {
        if (!recent) continue;
        if (block.type !== "attachment" && block.type !== "image" && block.type !== "audio" && block.type !== "video" && block.type !== "file") continue;
        const path = block.local_path ? resolve(root, block.local_path) : null;
        const rel = path ? relative(root, path) : "";
        let available = false;
        if (path && rel && !rel.startsWith("..") && !isAbsolute(rel)) {
          try { available = statSync(path).isFile(); } catch { /* Missing bytes. */ }
        }
        if (!block.sha256 || !/^[a-f0-9]{64}$/.test(block.sha256) || !available) missingAssets++;
      }
    } catch { unreadable++; }
  }
  return { missingAssets, unreadable, latest };
}
