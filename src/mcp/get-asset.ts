import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { relative, isAbsolute } from "node:path";
import { parseSessionId } from "../core/session-id";
import { assetHashes } from "../store/asset-hashes";
import { assetBlobPath, assetsDirForCanonicalDir, resolveLocalAssetPath } from "../store/assets";
import { readSession } from "../store/sessions";
import type { Block, MediaReference, Session } from "../schema/types";

/** Claude rejects images over 5 MB; other clients cap tool results similarly. */
export const MAX_INLINE_ASSET_BYTES = 5 * 1024 * 1024;

const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

type AssetContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; mimeType: string; blob: string } };

export type AssetToolResult = { content: AssetContent[]; isError?: boolean };

type MediaBlock = Extract<Block, MediaReference>;

interface AssetRef { sha256: string; block: MediaBlock | null; messageId: string | null }

const fail = (text: string): AssetToolResult => ({ content: [{ type: "text", text }], isError: true });

export function handleGetAsset(
  canonicalDir: string,
  args: { session_id: string; sha256: string },
  opts: { maxBytes?: number } = {},
): AssetToolResult {
  const parsed = parseSessionId(args.session_id);
  if (!parsed.ok) return fail(`Invalid session id "${args.session_id}": expected format "source:source_id"`);
  const sha256 = hashFromArg(args.sha256);
  if (!sha256) return fail(`Invalid asset "${args.sha256}": expected a 64-character lowercase hex sha256 or an assets/ local_path`);

  let session: Session;
  try { session = readSession(canonicalDir, parsed.source, parsed.sourceId); }
  catch { return fail(`Session "${args.session_id}" not found`); }
  // Only assets the session itself references are served, so a hash alone never unlocks a blob.
  if (!assetHashes(session).has(sha256)) return fail(`Asset ${sha256} is not referenced by session "${args.session_id}"`);

  // The hash must sit on an image or file block; the same string inside message text does not count.
  const ref = findAssetRef(session, sha256);
  if (!ref.block) return fail(`Asset ${sha256} is not referenced by session "${args.session_id}"`);
  const file = locateAssetFile(canonicalDir, ref);
  if (!file) return fail(`Asset ${sha256} is referenced by "${args.session_id}" but its file is not in the archive`);

  const sidecar = readSidecar(file.blob);
  const sizeBytes = statSync(file.path).size;
  const maxBytes = opts.maxBytes ?? MAX_INLINE_ASSET_BYTES;
  const declared = normalizeMime(ref.block?.mime_type) ?? normalizeMime(sidecar?.mime);
  const meta = {
    session_id: args.session_id,
    message_id: ref.messageId,
    sha256,
    filename: ref.block?.filename ?? null,
    mime_type: declared ?? "application/octet-stream",
    size_bytes: sizeBytes,
  };
  if (sizeBytes > maxBytes) {
    return { content: [{ type: "text", text: `Asset is ${sizeBytes} bytes, over the ${maxBytes} byte inline limit.\n${JSON.stringify(meta, null, 2)}` }], isError: true };
  }

  const bytes = readFileSync(file.path);
  // A per-session alias is only trusted when its bytes really hash to the requested asset.
  if (file.path !== file.blob && createHash("sha256").update(bytes).digest("hex") !== sha256) {
    return fail(`Asset ${sha256} is referenced by "${args.session_id}" but its file is not in the archive`);
  }
  const mime = sniffMime(bytes) ?? declared ?? "application/octet-stream";
  meta.mime_type = mime;
  const metaText: AssetContent = { type: "text", text: JSON.stringify(meta, null, 2) };
  if (INLINE_IMAGE_TYPES.has(mime)) {
    return { content: [metaText, { type: "image", data: bytes.toString("base64"), mimeType: mime }] };
  }
  if (mime.startsWith("text/") || mime === "application/json") {
    return { content: [metaText, { type: "text", text: bytes.toString("utf8") }] };
  }
  return { content: [metaText, { type: "resource", resource: { uri: `chat-scrobbler://assets/${args.session_id}/${sha256}`, mimeType: mime, blob: bytes.toString("base64") } }] };
}

function hashFromArg(value: string): string | null {
  if (/^[a-f0-9]{64}$/.test(value)) return value;
  const match = /^assets\/(?:[^/]+\/)*([a-f0-9]{64})(?:\.[a-z0-9]{1,12})?$/.exec(value);
  return match && !value.split("/").includes("..") ? match[1] : null;
}

function findAssetRef(session: Session, sha256: string): AssetRef {
  for (const message of session.messages) {
    for (const block of message.blocks) {
      if (!("local_path" in block)) continue;
      if (block.sha256 === sha256 || (block.local_path && assetHashes(block.local_path).has(sha256))) {
        return { sha256, block, messageId: message.id };
      }
    }
  }
  return { sha256, block: null, messageId: null };
}

function locateAssetFile(canonicalDir: string, ref: AssetRef): { path: string; blob: string } | null {
  const blob = assetBlobPath(canonicalDir, ref.sha256);
  if (existsSync(blob)) return { path: blob, blob };
  // Pre-blob uploads (v0.3.0) only exist at the per-session local_path.
  const localPath = ref.block?.local_path;
  if (!localPath) return null;
  const abs = resolveLocalAssetPath(canonicalDir, localPath);
  const rel = relative(assetsDirForCanonicalDir(canonicalDir), abs);
  if (rel.startsWith("..") || isAbsolute(rel) || !existsSync(abs)) return null;
  return { path: abs, blob };
}

function readSidecar(blob: string): { mime?: string } | null {
  try { return JSON.parse(readFileSync(`${blob}.json`, "utf8")); }
  catch { return null; }
}

function normalizeMime(value: string | null | undefined): string | null {
  const mime = value?.split(";")[0]?.trim().toLowerCase();
  return mime && mime !== "application/octet-stream" ? mime : null;
}

function sniffMime(bytes: Buffer): string | null {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (starts(0x25, 0x50, 0x44, 0x46, 0x2d)) return "application/pdf";
  return null;
}
