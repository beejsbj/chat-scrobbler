import type { Block, Message } from "../schema/types";
import type { UploadedAsset } from "../../packages/shared/src";
import type { AssetLookup } from "./assets";
import { mediaBlock } from "./parts";
import { renderText } from "./render";

const MEDIA = new Set(["image", "audio", "video", "file", "attachment"]);

export function mediaKind(mime?: string | null): "image" | "audio" | "video" | "file" {
  return mime?.startsWith("image/") ? "image" : mime?.startsWith("audio/") ? "audio"
    : mime?.startsWith("video/") ? "video" : "file";
}

export const linkedPointers = (blocks: Block[]): Set<string> =>
  new Set(blocks.flatMap(block => MEDIA.has(block.type) && "pointer" in block ? [block.pointer] : []));

function assetBlock(asset: UploadedAsset, lookup: AssetLookup): Block {
  return mediaBlock(mediaKind(asset.content_type), asset.pointer, lookup, asset.filename ?? null, asset.content_type ?? null);
}

/** Raw-capture assets recorded against `messageIds` that `existing` does not already link. */
export function capturedAssetBlocks(lookup: AssetLookup, messageIds: Array<string | null | undefined>, existing: Block[]): Block[] {
  const ids = new Set(messageIds.filter((id): id is string => !!id));
  if (!ids.size) return [];
  const seen = linkedPointers(existing);
  return lookup.all().flatMap(asset => {
    if (!asset.message_id || !ids.has(asset.message_id) || seen.has(asset.pointer)) return [];
    seen.add(asset.pointer);
    return [assetBlock(asset, lookup)];
  });
}

/** Append assets no message links yet: to their message_id, else to `fallbackId` when given. */
export function addCapturedAssets(messages: Message[], lookup: AssetLookup, fallbackId: string | null): void {
  const byId = new Map(messages.map(message => [message.id, message]));
  const seen = linkedPointers(messages.flatMap(message => message.blocks));
  for (const asset of lookup.all()) {
    if (seen.has(asset.pointer)) continue;
    const target = (asset.message_id ? byId.get(asset.message_id) : null)
      ?? (fallbackId ? byId.get(fallbackId) ?? messages.at(-1) : null);
    if (!target) continue;
    seen.add(asset.pointer);
    target.blocks.push(assetBlock(asset, lookup));
    target.text = renderText(target.blocks);
  }
}
