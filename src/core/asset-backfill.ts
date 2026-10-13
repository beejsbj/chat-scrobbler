// Asset backfill: the extension refetches expired-or-never-captured media pointers in a
// logged-in page, uploads the bytes, then commits the resulting hashes here. Canonical
// files are read directly so legacy sessions without raw captures take part too.
import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { AssetBackfillPage, AssetBackfillReference, ProviderSource, UploadedAsset } from "../../packages/shared/src";
import { indexSession } from "../indexer/sqlite";
import { renderText } from "../parsers/render";
import type { Block, Session } from "../schema/types";
import { AssetBlobMissingError, lookupAssetBlob, referenceExistingAsset } from "../store/asset-dedup";
import { resolveLocalAssetPath } from "../store/assets";
import { readRawCapture, storeRawCapture } from "../store/raw";
import { latestRawReference } from "../store/raw-catalog";
import { readSession, sessionFilePath, writeSession } from "../store/sessions";
import { isSessionDeleted } from "../store/tombstones";

export const BACKFILL_DEFAULT_LIMIT = 25;
export const BACKFILL_MAX_LIMIT = 100;
export const BACKFILL_MAX_ASSETS = 1000;
export const BACKFILL_MAX_BODY_BYTES = 1024 * 1024;

/** Categorical failure: `message` is safe to return to clients. */
export class BackfillError extends Error {
  constructor(readonly status: 400 | 404 | 410, message: string) { super(message); }
}

const MEDIA_TYPES = new Set(["attachment", "image", "audio", "video", "file"]);
type MediaBlock = Extract<Block, { pointer: string; local_path: string | null }>;
const isMedia = (block: Block): block is MediaBlock => MEDIA_TYPES.has(block.type) && typeof (block as any).pointer === "string";

function aliasExists(canonicalDir: string, localPath: string | null | undefined): boolean {
  if (!localPath || isAbsolute(localPath) || localPath.split(/[\/\\]/).includes("..")) return false;
  return existsSync(resolveLocalAssetPath(canonicalDir, localPath));
}
const needsLink = (canonicalDir: string, block: MediaBlock) => !aliasExists(canonicalDir, block.local_path);

export function parseBackfillLimit(value: string | null): number {
  if (value === null) return BACKFILL_DEFAULT_LIMIT;
  if (!/^[1-9]\d*$/.test(value) || Number(value) > BACKFILL_MAX_LIMIT) throw new BackfillError(400, `limit must be an integer from 1 to ${BACKFILL_MAX_LIMIT}`);
  return Number(value);
}

function sessionReferences(canonicalDir: string, session: Session): AssetBackfillReference[] {
  const seen = new Set<string>();
  const out: AssetBackfillReference[] = [];
  for (const message of session.messages ?? []) {
    for (const block of message.blocks ?? []) {
      if (!isMedia(block) || !block.pointer || !needsLink(canonicalDir, block)) continue;
      const key = JSON.stringify([message.id, block.pointer]);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ pointer: block.pointer, message_id: message.id ?? null, filename: block.filename ?? null, content_type: block.mime_type ?? null });
    }
  }
  return out;
}

/** One page of canonical sessions with unlinked media. Reads at most `limit` session files. */
export function listBackfillPage(canonicalDir: string, source: ProviderSource, after: string | null, limit: number): AssetBackfillPage {
  if (after !== null) sessionFilePath(canonicalDir, source, after);
  let names: string[] = [];
  try { names = readdirSync(join(canonicalDir, source)); } catch { /* no sessions for this provider */ }
  const ids = names.filter(name => name.endsWith(".json")).map(name => name.slice(0, -5))
    .filter(id => (after === null || id > after) && !isSessionDeleted(canonicalDir, source, id))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const scanned = ids.slice(0, limit);
  const sessions: AssetBackfillPage["sessions"] = [];
  for (const sourceId of scanned) {
    let session: Session;
    try { session = JSON.parse(readFileSync(sessionFilePath(canonicalDir, source, sourceId), "utf8")); }
    catch { continue; }
    const references = sessionReferences(canonicalDir, session);
    if (references.length) sessions.push({ source_id: sourceId, references });
  }
  return { ok: true, sessions, next_after: ids.length > limit ? scanned[scanned.length - 1] : null };
}

const optionalString = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new BackfillError(400, "asset fields must be strings");
  return value;
};

/** Validate client-supplied references; local_path and size are never trusted from the client. */
export function parseBackfillAssets(value: unknown): Array<{ pointer: string; message_id: string | null; filename: string | null; content_type: string | null; sha256: string }> {
  if (!Array.isArray(value)) throw new BackfillError(400, "assets must be an array");
  if (value.length > BACKFILL_MAX_ASSETS) throw new BackfillError(400, `at most ${BACKFILL_MAX_ASSETS} assets per request`);
  return value.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new BackfillError(400, "asset must be an object");
    const rec = item as Record<string, unknown>;
    if (typeof rec.pointer !== "string" || !rec.pointer.trim()) throw new BackfillError(400, "asset pointer is required");
    if (typeof rec.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(rec.sha256)) throw new BackfillError(400, "sha256 must be 64 lowercase hex characters");
    return { pointer: rec.pointer, message_id: optionalString(rec.message_id), filename: optionalString(rec.filename),
      content_type: optionalString(rec.content_type), sha256: rec.sha256 };
  });
}

export interface CommitBackfillInput {
  canonicalDir: string;
  rawDir: string;
  db: Database;
  source: ProviderSource;
  sourceId: string;
  assets: unknown;
}

const assetKey = (asset: { message_id?: string | null; pointer: string }) => JSON.stringify([asset.message_id ?? null, asset.pointer]);

/** Link already-uploaded blobs into an existing canonical session (and its raw lineage). */
export function commitBackfill(input: CommitBackfillInput): { linked: number; raw_ref: string | null } {
  const { canonicalDir, rawDir, db, source, sourceId } = input;
  try { sessionFilePath(canonicalDir, source, sourceId); } catch { throw new BackfillError(400, "source_id is invalid"); }
  const requested = parseBackfillAssets(input.assets);
  if (isSessionDeleted(canonicalDir, source, sourceId)) throw new BackfillError(410, "session was deleted");
  if (!existsSync(sessionFilePath(canonicalDir, source, sourceId))) throw new BackfillError(404, "session not found");
  for (const asset of requested) if (!lookupAssetBlob(canonicalDir, asset.sha256)) throw new BackfillError(404, "asset blob not found");

  const session = readSession(canonicalDir, source, sourceId);
  const matched = new Map<string, UploadedAsset>();
  for (const asset of requested) {
    const targets = session.messages.flatMap(message => (asset.message_id === null || asset.message_id === message.id)
      ? message.blocks.filter(isMedia).filter(block => block.pointer === asset.pointer).map(block => ({ message, block })) : []);
    const linkable = targets.filter(({ block }) => needsLink(canonicalDir, block) || block.sha256 === asset.sha256);
    if (!linkable.length) continue;
    let stored;
    try { stored = referenceExistingAsset({ canonicalDir, source, sourceId, sha256: asset.sha256, filename: asset.filename, contentType: asset.content_type }); }
    catch (error) { if (error instanceof AssetBlobMissingError) throw new BackfillError(404, "asset blob not found"); throw error; }
    for (const { message, block } of linkable) {
      block.local_path = stored.local_path;
      block.sha256 = stored.sha256;
      block.filename ??= asset.filename;
      block.mime_type ??= asset.content_type;
      message.text = renderText(message.blocks);
    }
    matched.set(assetKey({ message_id: asset.message_id ?? linkable[0].message.id, pointer: asset.pointer }), {
      pointer: asset.pointer, local_path: stored.local_path, message_id: asset.message_id ?? linkable[0].message.id,
      filename: asset.filename, content_type: asset.content_type, size_bytes: stored.size_bytes, sha256: stored.sha256 });
  }
  if (!matched.size) return { linked: 0, raw_ref: null };

  let rawRef: string | null = null;
  const latest = latestRawReference(rawDir, source, sourceId);
  if (latest) {
    const capture = readRawCapture(rawDir, latest);
    const kept = (capture.assets ?? []).filter(asset => !matched.has(assetKey(asset)));
    const merged = { ...capture, assets: [...kept, ...matched.values()], fetched_at: new Date().toISOString() };
    rawRef = storeRawCapture(rawDir, merged);
    session.raw_ref = rawRef;
  }
  writeSession(canonicalDir, session);
  indexSession(db, session, { canonicalDir });
  return { linked: matched.size, raw_ref: rawRef };
}
