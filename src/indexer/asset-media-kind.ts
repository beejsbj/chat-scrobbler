import type { Block } from "../schema/types";
import { assetHashes } from "../store/asset-hashes";

export type AssetMediaKind = "image" | "audio" | "video";
export interface LinkableAsset { sha256: string; media: AssetMediaKind }

const EXTENSIONS: Array<[AssetMediaKind, RegExp]> = [
  ["video", /\.(mp4|webm|mov|mkv)$/i],
  ["image", /\.(png|jpe?g|gif|webp|heic|heif|bmp|tiff?|avif)$/i],
  ["audio", /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac)$/i],
];

function kindFromName(name: string | null | undefined): AssetMediaKind | null {
  for (const [kind, pattern] of EXTENSIONS) if (pattern.test(name ?? "")) return kind;
  return null;
}
function kindFromMime(mime: string | null | undefined): AssetMediaKind | null {
  const top = /^(image|audio|video)\//i.exec(mime ?? "")?.[1].toLowerCase();
  return top ? top as AssetMediaKind : null;
}

/** Parsers emit image/audio/video/file blocks; `attachment` is the legacy shape. Index time never reads bytes. */
function mediaKind(block: Block): AssetMediaKind | null {
  switch (block.type) {
    case "image": case "audio": case "video": return block.type;
    case "attachment":
      return block.kind === "image" || block.kind === "audio" ? block.kind
        : /\.(mp4|webm|mov|mkv)$/i.test(block.filename ?? "") ? "video" : null;
    case "file": return kindFromMime(block.mime_type) ?? kindFromName(block.filename) ?? kindFromName(block.local_path);
    default: return null;
  }
}

/** The block's blob hash and media kind, or null when it is not embeddable media. */
export function linkableAsset(block: Block): LinkableAsset | null {
  if (block.type !== "attachment" && block.type !== "image" && block.type !== "audio" && block.type !== "video" && block.type !== "file") return null;
  const media = mediaKind(block);
  if (!media) return null;
  const sha256 = block.sha256 || [...assetHashes(block.local_path ?? "")][0];
  return sha256 && /^[a-f0-9]{64}$/.test(sha256) ? { sha256, media } : null;
}
