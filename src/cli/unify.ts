// src/cli/unify.ts
// Rebuilds the SQLite index from canonical session files.
// Two tiers: canonical/ (source of truth) -> index/ (rebuildable view).
import { existsSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Session } from "../schema/types";
import { listSessionFiles } from "../store/sessions";
import { openIndex, indexSession } from "../indexer/sqlite";
import { loadConfig } from "../config";

export interface UnifyOptions { canonicalDir: string; indexPath: string; }

export async function runUnify(opts: UnifyOptions): Promise<number> {
  const files = listSessionFiles(opts.canonicalDir);

  mkdirSync(dirname(opts.indexPath), { recursive: true });
  if (existsSync(opts.indexPath)) rmSync(opts.indexPath);
  const db = openIndex(opts.indexPath);
  db.run("BEGIN");
  let count = 0;
  for (const f of files) {
    let session: Session;
    try {
      session = JSON.parse(readFileSync(f, "utf8")) as Session;
    } catch {
      continue;
    }
    indexSession(db, session);
    count++;
  }
  db.run("COMMIT");
  db.close();
  return count;
}

if (import.meta.main) {
  const cfg = loadConfig();
  const count = await runUnify({ canonicalDir: cfg.canonicalDir, indexPath: cfg.indexPath });
  console.log(`Reindexed ${count} sessions from canonical into index.`);
}
