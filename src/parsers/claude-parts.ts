import type { Block } from "../schema/types";
import { assetLookupFromRaw, type AssetLookup } from "./assets";
import { capturedAssetBlocks, linkedPointers, mediaKind } from "./captured-assets";
import { childLocation, mediaBlock, toolCall, unknownBlock, type PartLocation } from "./parts";
import type { RawClaudeMsg } from "./claude";

type Artifact = Extract<Block, { type: "artifact" }>;
// Content types with nothing to show: the raw capture keeps them. A type not listed here stays unknown.
const IGNORED_CONTENT = new Set([
  "token_budget", // remaining-budget counter, no reader-facing content
  "flag",         // classifier flag with a helpline card the interface renders itself
]);
export function blocksFromClaude(m: RawClaudeMsg, allAssets: AssetLookup = assetLookupFromRaw(null),
  loc: PartLocation = { raw_ref: "", raw_path: "" }, artifacts = new Map<string, Artifact>()): Block[] {
  const assets = allAssets.scoped([m.uuid]);
  const blocks: Block[] = [];
  const citedUrls = new Set<string>();
  for (const [i, c] of (m.content ?? []).entries()) {
    const at = childLocation(loc, "content", i);
    switch (c?.type) {
      case "text":
      case "voice_note":
        if (typeof c.text === "string") { if (c.text.trim()) blocks.push({ type: "text", text: c.text }); }
        else blocks.push(unknownBlock(c, at));
        break;
      case "thinking":
        if (typeof c.thinking === "string") blocks.push({ type: "reasoning", text: c.thinking });
        else blocks.push(unknownBlock(c, at));
        break;
      case "tool_use":
        if (c.name === "artifacts" && c.input && typeof c.input.id === "string") {
          const input = c.input;
          const prior = artifacts.get(input.id);
          const artifact: Artifact = { type: "artifact", artifact_id: input.id, kind: input.type ?? prior?.kind ?? "",
            title: input.title ?? prior?.title ?? null, version: input.version_uuid ?? null,
            content: typeof input.content === "string" ? input.content : "",
            operation: input.command ?? "create", previous_version: input.parent_version_uuid ?? prior?.version ?? null };
          // The API leaves out an empty side of an edit, so an insertion carries only new_str and a deletion only old_str.
          if (typeof input.old_str === "string" || typeof input.new_str === "string") {
            artifact.edits = [{ old_str: typeof input.old_str === "string" ? input.old_str : "", new_str: typeof input.new_str === "string" ? input.new_str : "" }];
          }
          // A create that names the artifact but carries no body is complete. Any other bodiless shape is preserved alongside its artifact label.
          if (!artifact.content && !artifact.edits && !(artifact.operation === "create" && artifact.title)) blocks.push(unknownBlock(c, at));
          blocks.push(artifact);
          artifacts.set(input.id, artifact);
        } else blocks.push(toolCall(typeof c.name === "string" ? c.name : "tool"));
        break;
      case "tool_result":
        blocks.push(toolCall(typeof c.name === "string" ? c.name : "tool"));
        blocks.push(...nestedMedia(c.content, assets));
        break;
      case "image": {
        const pointer = c.file_uuid ?? c.source?.file_uuid ?? c.source?.file_id;
        if (typeof pointer === "string" && pointer) {
          const mime = c.source?.media_type ?? assets.byPointer(pointer)?.content_type ?? null;
          blocks.push(mediaBlock("image", pointer, assets, null, mime));
        } else blocks.push(unknownBlock(c, at));
        break;
      }
      default:
        if (!IGNORED_CONTENT.has(c?.type)) blocks.push(unknownBlock(c, at));
    }
    for (const [j, citation] of (Array.isArray(c?.citations) ? c.citations : []).entries()) {
      // Documented Messages API citation shape. Other web-client references stay opaque.
      if (citation?.type === "web_search_result_location" && typeof citation.url === "string") {
        blocks.push({ type: "citation", provider_type: citation.type, url: citation.url,
          title: typeof citation.title === "string" ? citation.title : null,
          text: typeof citation.cited_text === "string" ? citation.cited_text : null });
      } else if (typeof citation?.url === "string" && citation.url && citation.type === undefined) {
        // Web-client citation: no type tag, the page in url/title, the span in start_index/end_index.
        const key = citation.url;
        if (citedUrls.has(key)) continue;
        citedUrls.add(key);
        blocks.push({ type: "citation", provider_type: typeof citation.metadata?.type === "string" ? citation.metadata.type : "web_citation",
          url: citation.url, title: typeof citation.title === "string" && citation.title ? citation.title : null, text: null });
      } else blocks.push(unknownBlock(citation, childLocation(at, "citations", j), "citation"));
    }
  }
  if (!blocks.some(block => ["text", "reasoning", "artifact"].includes(block.type)) && m.text?.trim()) {
    blocks.push({ type: "text", text: m.text });
  }
  const linked = linkedPointers(blocks);
  for (const key of ["files", "files_v2", "generated_files", "attachments"] as const) {
    for (const [i, file] of (m[key] ?? []).entries()) {
      const pointer = file?.file_uuid ?? file?.uuid ?? file?.id ?? file?.attachment_uuid ?? file?.path;
      if (typeof pointer !== "string" || !pointer) { blocks.push(unknownBlock(file, childLocation(loc, key, i), key)); continue; }
      // An image content block already links this upload.
      if (linked.has(pointer)) continue;
      linked.add(pointer);
      const mime = file.content_type ?? file.mime_type ?? assets.byPointer(pointer)?.content_type;
      const type = typeof mime === "string" && mime.startsWith("image/") ? "image"
        : typeof mime === "string" && mime.startsWith("audio/") ? "audio"
        : typeof mime === "string" && mime.startsWith("video/") ? "video" : "file";
      blocks.push(mediaBlock(type, pointer, assets, file.file_name ?? file.filename ?? file.name ?? null, mime ?? null));
    }
  }
  blocks.push(...capturedAssetBlocks(assets, [m.uuid], blocks));
  return blocks;
}

/** Tool results can carry file-backed visuals; inline base64 sources have no pointer and link by message_id. */
function nestedMedia(content: unknown, assets: AssetLookup): Block[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((item: any): Block[] => {
    const pointer = item?.source?.file_uuid ?? item?.source?.file_id ?? item?.file_uuid;
    if (typeof pointer !== "string" || !pointer || !["image", "document", "file"].includes(item?.type)) return [];
    const mime = item.source?.media_type ?? item.mime_type ?? assets.byPointer(pointer)?.content_type ?? null;
    return [mediaBlock(mediaKind(mime), pointer, assets, item.file_name ?? null, mime)];
  });
}
