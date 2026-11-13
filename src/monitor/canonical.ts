import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { listSessionFiles } from "../store/sessions";
import type { Session } from "../schema/types";
import { SOURCES } from "../store/raw-catalog";
import { ignoreKey, reportedPointer } from "./asset-ignores";

/**
 * When a message was created. One with no timestamp (Gemini user turns) takes the next timestamped
 * message's time, since its reply follows it; with none after it, the session's last update, which
 * that trailing message is what most likely moved.
 */
function messageTimes(session: Session): number[] {
  const times: number[] = [];
  let next = Date.parse(session.updated_at);
  for (let index = session.messages.length - 1; index >= 0; index--) {
    const created = Date.parse(session.messages[index]!.created_at ?? "");
    if (Number.isFinite(created)) next = created;
    times[index] = next;
  }
  return times;
}

/**
 * Counts media blocks with no stored file on messages created since `since`: new content whose assets
 * failed. Old missing media in a chat that is active again is not new, and assets the owner ignored
 * (`ignoredKeys(source)`: the receiver's asset_ignores) are a decision, not a failure.
 */
export function canonicalObservations(canonicalDir: string, since: number, ignoredKeys?: (source: Session["source"]) => Set<string>) {
  let missingAssets = 0, unreadable = 0;
  const ignoredBySource = new Map<string, Set<string>>();
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
      // Message times, not file times or session activity: rebuilds and new messages must not re-date old media.
      const times = messageTimes(session);
      session.messages.forEach((message, index) => { for (const block of message.blocks) {
        if (!(times[index]! >= since)) continue;
        if (block.type !== "attachment" && block.type !== "image" && block.type !== "audio" && block.type !== "video" && block.type !== "file") continue;
        const path = block.local_path ? resolve(root, block.local_path) : null;
        const rel = path ? relative(root, path) : "";
        let available = false;
        if (path && rel && !rel.startsWith("..") && !isAbsolute(rel)) {
          try { available = statSync(path).isFile(); } catch { /* Missing bytes. */ }
        }
        if (block.sha256 && /^[a-f0-9]{64}$/.test(block.sha256) && available) continue;
        if (ignoredKeys) {
          if (!ignoredBySource.has(session.source)) ignoredBySource.set(session.source, ignoredKeys(session.source));
          const pointer = reportedPointer(block.pointer), ignored = ignoredBySource.get(session.source)!;
          // An ignore recorded without a message id (stored as "") covers that pointer in the whole session.
          if (ignored.has(ignoreKey(session.source_id, message.id, pointer)) || ignored.has(ignoreKey(session.source_id, null, pointer))) continue;
        }
        missingAssets++;
      } });
    } catch { unreadable++; }
  }
  return { missingAssets, unreadable, latest };
}
