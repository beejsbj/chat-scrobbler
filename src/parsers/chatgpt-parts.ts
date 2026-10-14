import type { Block } from "../schema/types";
import { assetLookupFromRaw, type AssetLookup } from "./assets";
import { childLocation, mediaBlock, toolCall, unknownBlock, type PartLocation } from "./parts";

export function blocksFromContent(content: any, assets: AssetLookup = assetLookupFromRaw(null),
  loc: PartLocation = { raw_ref: "", raw_path: "" }): Block[] {
  if (content == null) return [];
  const ct = content.content_type;
  const rootMedia = voiceMedia(content, assets);
  if (rootMedia.length) return rootMedia;
  if (ct === "text" || ct === "multimodal_text") {
    if (!Array.isArray(content.parts)) return [...proseBlocks(content), unknownBlock(content, loc)];
    const blocks: Block[] = ct === "text" ? proseBlocks(content) : [];
    return [...blocks, ...content.parts.flatMap((part: any, i: number): Block[] => {
      const at = childLocation(loc, "parts", i);
      if (typeof part === "string") return ct === "text" ? [] : part.trim() ? [{ type: "text", text: part }] : [];
      if (part?.content_type === "audio_transcription" && typeof part.text === "string") return [{ type: "text", text: part.text }];
      if (part?.content_type === "image_asset_pointer" && typeof part.asset_pointer === "string") {
        return [mediaBlock("image", part.asset_pointer, assets)];
      }
      const audioVideo = voiceMedia(part, assets);
      if (audioVideo.length) return audioVideo;
      return [...proseBlocks(part), unknownBlock(part, at)];
    })];
  }
  if (ct === "thoughts" && Array.isArray(content.thoughts)) {
    return content.thoughts.flatMap((thought: any, i: number): Block[] => typeof thought?.content === "string"
      ? [{ type: "reasoning", text: thought.content }]
      : [unknownBlock(thought, childLocation(loc, "thoughts", i), "thoughts")]);
  }
  if (ct === "reasoning_recap" && typeof content.content === "string") {
    return [{ type: "reasoning", text: content.content, summary: true }];
  }
  if (ct === "code" || ct === "execution_output") return [toolCall("code")];
  if (ct === "model_editable_context" || ct === "user_editable_context") {
    const text = [content.model_set_context, content.profile, content.instructions]
      .filter((s: any) => typeof s === "string" && s.trim()).join("\n\n");
    if (text) return [{ type: "reasoning", text }];
  }
  return [...proseBlocks(content), unknownBlock(content, loc)];
}

function proseBlocks(content: any): Block[] {
  const strings = Array.isArray(content?.parts) ? content.parts.filter((part: unknown) => typeof part === "string") : [];
  const text = [typeof content?.text === "string" ? content.text : "", ...strings].filter(Boolean).join("\n").trim();
  return text ? [{ type: "text", text }] : [];
}

function voiceMedia(part: any, assets: AssetLookup): Block[] {
  if (!["audio", "input_audio", "input_audio_buffer", "audio_unconditional", "audio_asset_pointer",
    "real_time_user_audio_video_asset_pointer", "video", "video_asset_pointer"].includes(part?.content_type)) return [];
  const audio = part.asset_pointer ?? (typeof part.audio_asset_pointer === "string" ? part.audio_asset_pointer : part.audio_asset_pointer?.asset_pointer);
  const video = typeof part.video_container_asset_pointer === "string" ? part.video_container_asset_pointer : part.video_container_asset_pointer?.asset_pointer;
  const out: Block[] = [];
  if (typeof audio === "string") out.push(mediaBlock(part.content_type.startsWith("video") ? "video" : "audio", audio, assets));
  if (typeof video === "string") out.push(mediaBlock("video", video, assets));
  return out;
}
