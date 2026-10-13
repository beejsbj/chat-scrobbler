import type { Block } from "../schema/types";
import { assetLookupFromRaw, type AssetLookup } from "./assets";
import { childLocation, mediaBlock, toolCall, unknownBlock, type PartLocation } from "./parts";
import type { RawClaudeMsg } from "./claude";

type Artifact = Extract<Block, { type: "artifact" }>;
export function blocksFromClaude(m: RawClaudeMsg, assets: AssetLookup = assetLookupFromRaw(null),
  loc: PartLocation = { raw_ref: "", raw_path: "" }, artifacts = new Map<string, Artifact>()): Block[] {
  const blocks: Block[] = [];
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
          if (typeof input.old_str === "string" && typeof input.new_str === "string") {
            artifact.edits = [{ old_str: input.old_str, new_str: input.new_str }];
          }
          // An unrecognized edit shape is preserved alongside its artifact label.
          if (!artifact.content && !artifact.edits) blocks.push(unknownBlock(c, at));
          blocks.push(artifact);
          artifacts.set(input.id, artifact);
        } else blocks.push(toolCall(typeof c.name === "string" ? c.name : "tool"));
        break;
      case "tool_result":
        blocks.push(toolCall(typeof c.name === "string" ? c.name : "tool"));
        break;
      default:
        blocks.push(unknownBlock(c, at));
    }
    for (const [j, citation] of (Array.isArray(c?.citations) ? c.citations : []).entries()) {
      // Documented Messages API citation shape. Other web-client references stay opaque.
      if (citation?.type === "web_search_result_location" && typeof citation.url === "string") {
        blocks.push({ type: "citation", provider_type: citation.type, url: citation.url,
          title: typeof citation.title === "string" ? citation.title : null,
          text: typeof citation.cited_text === "string" ? citation.cited_text : null });
      } else blocks.push(unknownBlock(citation, childLocation(at, "citations", j), "citation"));
    }
  }
  if (!blocks.length && m.text?.trim()) blocks.push({ type: "text", text: m.text });
  for (const key of ["files", "attachments"] as const) {
    for (const [i, file] of (m[key] ?? []).entries()) {
      const pointer = file?.file_uuid ?? file?.uuid ?? file?.id ?? file?.attachment_uuid;
      if (typeof pointer !== "string" || !pointer) { blocks.push(unknownBlock(file, childLocation(loc, key, i), key)); continue; }
      const mime = file.content_type ?? file.mime_type ?? assets.byPointer(pointer)?.content_type;
      const type = typeof mime === "string" && mime.startsWith("image/") ? "image"
        : typeof mime === "string" && mime.startsWith("audio/") ? "audio"
        : typeof mime === "string" && mime.startsWith("video/") ? "video" : "file";
      blocks.push(mediaBlock(type, pointer, assets, file.file_name ?? file.filename ?? file.name ?? null, mime ?? null));
    }
  }
  return blocks;
}
