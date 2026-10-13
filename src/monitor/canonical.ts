import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { listSessionFiles } from "../store/sessions";
import type { Session } from "../schema/types";

export function canonicalObservations(canonicalDir: string, since: number) {
  let missingAssets = 0, unreadable = 0;
  const root = resolve(dirname(canonicalDir));
  for (const file of listSessionFiles(canonicalDir)) {
    try {
      const session = JSON.parse(readFileSync(file, "utf8")) as Session;
      if (!Array.isArray(session.messages)) throw new Error("invalid session");
      // Check recently captured sessions even when their conversation is old.
      const recent = Math.max(Date.parse(session.updated_at) || 0, statSync(file).mtimeMs) >= since;
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
  return { missingAssets, unreadable };
}
