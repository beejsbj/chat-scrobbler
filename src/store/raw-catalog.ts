import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Source } from "../schema/types";
import { listRawCaptures } from "./raw";
import { encodedSegment } from "./tombstones";

export const SOURCES: Source[] = ["chatgpt", "claude", "gemini"];
export interface RawIdentity { source: Source; source_id: string }

export function listRawSessions(rawDir: string): RawIdentity[] {
  return SOURCES.flatMap(source => {
    const dir = join(rawDir, source);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      if (!entry.isDirectory()) return [];
      try { return [{ source, source_id: decodeURIComponent(entry.name) }]; }
      catch { return []; }
    });
  });
}

/** Read-only counterpart to ingest's latestRaw: dry-run never repairs metadata. */
export function latestRawReference(rawDir: string, source: string, sourceId: string): string | null {
  const refs = listRawCaptures(rawDir, source, sourceId);
  if (!refs.length) return null;
  try {
    const latest = JSON.parse(readFileSync(join(rawDir, encodedSegment(source), encodedSegment(sourceId), "latest.json"), "utf8"));
    const ref = join(dirname(refs[0]), latest.file);
    if (refs.includes(ref)) return ref;
  } catch { /* Archives without a valid marker use arrival mtime. */ }
  return refs.reduce((newest, ref) => statSync(join(rawDir, ref)).mtimeMs >= statSync(join(rawDir, newest)).mtimeMs ? ref : newest);
}
