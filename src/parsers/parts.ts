import type { Block, MediaReference } from "../schema/types";
import type { AssetLookup } from "./assets";

export interface ParserContext { raw_ref?: string }
export interface PartLocation { raw_ref: string; raw_path: string }
export const UNKNOWN_JSON_MAX_BYTES = 16 * 1024;
export const pointerSegment = (key: string | number) => String(key).replace(/~/g, "~0").replace(/\//g, "~1");
export const childLocation = (loc: PartLocation, ...keys: Array<string | number>): PartLocation =>
  ({ ...loc, raw_path: loc.raw_path + keys.map(key => "/" + pointerSegment(key)).join("") });

/** Preserve opaque JSON exactly below the cap, otherwise reference archived bytes. */
export function unknownBlock(value: unknown, loc: PartLocation, fallback = "untyped"): Block {
  const rec = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const providerType = typeof rec.content_type === "string" ? rec.content_type : typeof rec.type === "string" ? rec.type : fallback;
  const size = Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
  const truncated = size > UNKNOWN_JSON_MAX_BYTES;
  return { type: "unknown", provider_type: providerType, raw_json: truncated ? null : value ?? null,
    ...loc, truncated, size_bytes: size };
}

export function mediaBlock(type: "image" | "audio" | "video" | "file", pointer: string,
  assets: AssetLookup, filename: string | null = null, mime: string | null = null): Block {
  const asset = assets.byPointer(pointer);
  const ref: MediaReference = { pointer, filename: filename ?? asset?.filename ?? null,
    local_path: asset?.local_path ?? null, sha256: asset?.sha256 ?? null, mime_type: mime ?? asset?.content_type ?? null };
  return { type, ...ref };
}

/** Classify known tool families; keep unfamiliar names without inventing a family. */
export function toolCall(name: string): Block {
  const prefix = name.split(".")[0];
  const families = new Map(Object.entries({ canmore: "canvas", artifacts: "canvas", image_gen: "image_gen", dalle: "image_gen",
    browser: "browsing", web: "browsing", web_search: "browsing", python: "python" }));
  const tool_type = families.get(prefix) ?? prefix;
  return { type: "tool_call", name, tool_type };
}
