import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeImmutableFile } from "./immutable-file";

export interface Tombstone { source: string; source_id: string; deleted_at: string }
export const encodedSegment = (value: string) => encodeURIComponent(value).replace(/\./g, "%2E");
export const tombstoneDir = (canonicalDir: string) => join(canonicalDir, ".deleted");
const tombstonePath = (dir: string, source: string, id: string) => join(tombstoneDir(dir), encodedSegment(source), `${encodedSegment(id)}.json`);
export function isSessionDeleted(dir: string, source: string, id: string): boolean {
  return existsSync(tombstonePath(dir, source, id));
}
export function assertSessionNotDeleted(dir: string, source: string, id: string): void {
  if (isSessionDeleted(dir, source, id)) throw new Error("session was deleted");
}
export function markSessionDeleted(dir: string, record: Tombstone): void {
  writeImmutableFile(tombstonePath(dir, record.source, record.source_id), JSON.stringify({ source: record.source, source_id: record.source_id, deleted_at: record.deleted_at }));
}
export function listTombstones(dir: string): Tombstone[] {
  if (!existsSync(tombstoneDir(dir))) return [];
  return [...new Bun.Glob("*/*.json").scanSync({ cwd: tombstoneDir(dir), absolute: true })].map(file => JSON.parse(readFileSync(file, "utf8")));
}
