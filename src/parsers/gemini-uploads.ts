// Files the user attached to a Gemini message (`turn[2][0][4]`). The descriptor carries a name, a type code,
// an opaque upload token and preview and download urls. The token never leaves this module; urls only ever
// serve as the media pointer the extension already uses, so nothing opaque reaches rendered text.
import { createHash } from "node:crypto";
import type { Block } from "../schema/types";
import type { AssetLookup } from "./assets";
import { mediaKind } from "./captured-assets";
import { mediaBlock } from "./parts";

export interface GeminiUpload { filename: string; token: string; urls: string[] }

const MAX_DEPTH = 4;
const named = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/** `[null, type code, filename, null, null, token, null, [preview, download, preview], ...]` */
const asUpload = (node: unknown[]): GeminiUpload | null =>
  node[0] === null && typeof node[1] === "number" && named(node[2]) && named(node[5])
    ? { filename: node[2].trim(), token: node[5], urls: Array.isArray(node[7]) ? node[7].filter((u): u is string => typeof u === "string" && /^https:\/\//.test(u)) : [] }
    : null;

/** Every file in the slot, or null unless the slot is made only of nulls, nesting and file descriptors. */
export function parseGeminiUploads(value: unknown): GeminiUpload[] | null {
  const found = new Map<string, GeminiUpload>();
  const walk = (node: unknown, depth: number): boolean => {
    if (node === null || node === undefined) return true;
    if (!Array.isArray(node) || depth > MAX_DEPTH) return false;
    const upload = asUpload(node);
    if (upload) { if (!found.has(upload.token)) found.set(upload.token, upload); return true; }
    return node.every(child => walk(child, depth + 1));
  };
  return walk(value, 0) && found.size ? [...found.values()] : null;
}

const kindFromName = (name: string): "image" | "audio" | "video" | "file" =>
  /\.(?:png|jpe?g|gif|webp|heic|bmp)$/i.test(name) ? "image" : /\.(?:mp3|wav|m4a|ogg|flac)$/i.test(name) ? "audio"
    : /\.(?:mp4|mov|webm|mkv|avi)$/i.test(name) ? "video" : "file";

/** The captured asset when one of the file's urls was captured, else a block that names the file with no local copy. */
export function uploadBlock(upload: GeminiUpload, lookup: AssetLookup): Block {
  const captured = upload.urls.find(url => lookup.byPointer(url));
  if (captured) {
    const asset = lookup.byPointer(captured)!;
    return mediaBlock(mediaKind(asset.content_type), captured, lookup, upload.filename, asset.content_type ?? null);
  }
  const pointer = upload.urls[1] ?? upload.urls[0] ?? `gemini-upload:sha256:${createHash("sha256").update(upload.token).digest("hex")}`;
  return mediaBlock(kindFromName(upload.filename), pointer, lookup, upload.filename);
}
