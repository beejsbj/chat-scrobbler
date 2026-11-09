import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { MAX_ASSET_FAILURE_POINTER_CHARS } from "../../packages/shared/src/asset-failure";
import { withState } from "./state-db";
import { assertStateOwner } from "./state-owner";

/**
 * Manual ignore: the only state that stops an extension from retrying a failed asset. The owner
 * names a failing asset by a short id (`chat-scrobbler assets failing`); the receiver then answers
 * `ignored_assets` to that asset's next failure report, and the extension stops attempting it.
 */
export interface AssetKey { source: string; source_id: string; message_id: string | null; pointer: string; }
export interface FailingAsset extends AssetKey { id: string; reason: string; attempts: number; first_seen: number; last_seen: number; }
export interface IgnoredAsset extends AssetKey { id: string; reason: string; ignored_at: number; }
export type IgnoreResult = { status: "ignored" | "already_ignored" | "unignored"; asset: AssetKey & { id: string } } | { status: "not_found" | "no_pointer"; asset?: undefined };

/** The pointer form an extension reports: past the length cap it travels as sha256:<hex>. */
export function reportedPointer(pointer: string): string {
  return pointer.length > MAX_ASSET_FAILURE_POINTER_CHARS ? `sha256:${createHash("sha256").update(pointer).digest("hex")}` : pointer;
}

export function assetId(asset: AssetKey): string {
  return createHash("sha256").update(JSON.stringify([asset.source, asset.source_id, asset.message_id ?? "", asset.pointer])).digest("hex").slice(0, 12);
}

const rowKey = (row: { source: string; source_id: string; message_id: string; pointer: string }): AssetKey =>
  ({ source: row.source, source_id: row.source_id, message_id: row.message_id === "" ? null : row.message_id, pointer: row.pointer });

/** Read-only, and tolerant of a state file from before the table existed. */
function readTable<T>(path: string, table: "asset_outcomes" | "asset_ignores", suffix: string, params: unknown[] = []): T[] {
  if (!existsSync(path)) return [];
  assertStateOwner(path);
  const db = new Database(path, { readonly: true });
  try {
    db.run("PRAGMA busy_timeout = 0");
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) return [];
    return db.query(`SELECT * FROM ${table} ${suffix}`).all(...params as any[]) as T[];
  } finally { db.close(); }
}

export function listFailingAssets(path: string): FailingAsset[] {
  return readTable<any>(path, "asset_outcomes", "ORDER BY last_seen DESC")
    .map(row => ({ ...rowKey(row), id: assetId(rowKey(row)), reason: row.reason, attempts: row.attempts, first_seen: row.first_seen, last_seen: row.last_seen }));
}

export function listIgnoredAssets(path: string): IgnoredAsset[] {
  return readTable<any>(path, "asset_ignores", "ORDER BY ignored_at DESC")
    .map(row => ({ ...rowKey(row), id: assetId(rowKey(row)), reason: row.reason, ignored_at: row.ignored_at }));
}

/** Pointers of the given source whose ignore is recorded, as `[source_id, message_id, pointer]` JSON keys. */
export function ignoredAssetKeys(path: string, source: string): Set<string> {
  return new Set(readTable<any>(path, "asset_ignores", "WHERE source = ?", [source])
    .map(row => JSON.stringify([row.source_id, row.message_id, row.pointer])));
}
export const ignoreKey = (sourceId: string, messageId: string | null, pointer: string) => JSON.stringify([sourceId, messageId ?? "", pointer]);

/** Moves a failing asset into the ignore list. Idempotent; a pointer-less record is refused because it would match every pointer-less failure of its message. */
export function ignoreAsset(path: string, id: string, now = Date.now()): IgnoreResult {
  return withState(path, db => db.transaction((): IgnoreResult => {
    const failing = (db.query("SELECT * FROM asset_outcomes").all() as any[]).find(row => assetId(rowKey(row)) === id);
    if (failing) {
      if (failing.pointer === "") return { status: "no_pointer" };
      db.run("INSERT INTO asset_ignores VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING", [failing.source, failing.source_id, failing.message_id, failing.pointer, failing.reason, now]);
      db.run("DELETE FROM asset_outcomes WHERE source = ? AND source_id = ? AND message_id = ? AND pointer = ?", [failing.source, failing.source_id, failing.message_id, failing.pointer]);
      return { status: "ignored", asset: { ...rowKey(failing), id } };
    }
    const existing = (db.query("SELECT * FROM asset_ignores").all() as any[]).find(row => assetId(rowKey(row)) === id);
    return existing ? { status: "already_ignored", asset: { ...rowKey(existing), id } } : { status: "not_found" };
  })());
}

/** Lets an ignored asset count and retry again: its next failure report is recorded, and backfill offers it. */
export function unignoreAsset(path: string, id: string): IgnoreResult {
  return withState(path, db => db.transaction((): IgnoreResult => {
    const existing = (db.query("SELECT * FROM asset_ignores").all() as any[]).find(row => assetId(rowKey(row)) === id);
    if (!existing) return { status: "not_found" };
    db.run("DELETE FROM asset_ignores WHERE source = ? AND source_id = ? AND message_id = ? AND pointer = ?", [existing.source, existing.source_id, existing.message_id, existing.pointer]);
    return { status: "unignored", asset: { ...rowKey(existing), id } };
  })());
}
