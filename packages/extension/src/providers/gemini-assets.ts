import { asObject } from "./types";
import { estimatedBase64Bytes, type ProviderAssetCandidate } from "./assets";

/** A `data:` media URL found in Gemini data. It is decoded through the inline path and never kept as a pointer or url. */
export interface InlineDataMedia {
  dataUrl: string; messageId: string | null; mime: string | null; filename: string | null;
  /** A descriptor's own stable id (file_id) replaces the digest pointer. */
  pointer?: string;
}

// SVG is page chrome (icons), never a Gemini upload or generation, and is active content.
const DATA_URL = /^data:((?:image(?!\/svg)|audio|video)\/[\w.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/i;
export const isDataUrl = (value: string): boolean => /^data:/i.test(value);
export const INLINE_POINTER_PREFIX = "gemini-inline:sha256:";

/**
 * Turns data: URLs into inline candidates under a short stable pointer (a digest of the data URL).
 * A value that is not base64 media, or whose bytes exceed `maxBytes`, is dropped: nothing derived
 * from it may reach asset references, the raw capture's asset list or a failure report.
 */
export async function inlineDataCandidates(media: InlineDataMedia[], sourceId: string, maxBytes: number): Promise<ProviderAssetCandidate[]> {
  const out: ProviderAssetCandidate[] = [];
  for (const item of media) {
    const match = DATA_URL.exec(item.dataUrl);
    if (!match || match[2].length % 4 !== 0 || estimatedBase64Bytes(match[2]) > maxBytes) continue;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(item.dataUrl));
    const pointer = item.pointer ?? INLINE_POINTER_PREFIX + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    out.push({ source: "gemini", sourceId, pointer, url: null, messageId: item.messageId, filename: item.filename,
      contentType: item.mime ?? match[1].toLowerCase(), inlineBase64: match[2] });
  }
  return out;
}

/**
 * Rich-content slots follow HanaokaYuzu/Gemini-API's Field + _parse_candidate.
 * Upload metadata is obfuscated: scan only media URLs/descriptors inside user metadata.
 * These selectors are source-verified, but UNVERIFIED against this user's live hNvQHb captures.
 */
export function geminiApiAssetCandidates(payload: unknown, sourceId: string): ProviderAssetCandidate[] {
  return scanGeminiApiAssets(payload, sourceId).candidates;
}

/** Link candidates, plus the data: media that `inlineDataCandidates` decodes. */
export function scanGeminiApiAssets(payload: unknown, sourceId: string): { candidates: ProviderAssetCandidate[]; inline: InlineDataMedia[] } {
  const out: ProviderAssetCandidate[] = [];
  const inline: InlineDataMedia[] = [];
  if (!Array.isArray(payload) || !Array.isArray(payload[0])) return { candidates: out, inline };
  const add = (pointer: string, messageId: string | null, mime: string | null = null, filename: string | null = null, url = pointer) => {
    if (isDataUrl(pointer)) { inline.push({ dataUrl: pointer, messageId, mime, filename }); return; }
    if (isDataUrl(url)) { inline.push({ dataUrl: url, messageId, mime, filename, pointer }); return; }
    out.push({ source: "gemini", sourceId, pointer, messageId, url: downloadable(url) ? url : null,
      contentType: mime, filename, fetchViaBackground: /^https?:/.test(url) && !url.startsWith("https://gemini.google.com/") });
  };
  const visit = (value: unknown, messageId: string | null, hint: string | null = null): void => {
    if (typeof value === "string") {
      if (providerMediaUrl(value)) add(value, messageId, hint);
      return;
    }
    if (Array.isArray(value)) {
      const mime = value.find(v => typeof v === "string" && /^(image|audio|video|application)\/[\w.+-]+$/.test(v));
      value.forEach(v => visit(v, messageId, typeof mime === "string" ? mime : hint));
      return;
    }
    const item = asObject(value);
    const mime = str(item.mime_type ?? item.content_type ?? item.media_type) ?? hint;
    const url = str(item.download_url ?? item.export_url ?? item.url ?? item.uri);
    const pointer = str(item.asset_pointer ?? item.file_id) ?? url;
    if (pointer && (mime || /image|audio|video|file|document|export/.test(str(item.type) ?? "") || item.download_url || item.export_url)) {
      add(pointer, messageId, mime, str(item.name ?? item.filename), url ?? pointer);
      return;
    }
    Object.values(item).forEach(v => visit(v, messageId, mime));
  };
  for (const turn of payload[0]) {
    if (!Array.isArray(turn)) continue;
    const userId = str(at(turn, [0, 1]));
    visit(turn[2], userId);
    const candidates = at(turn, [3, 0]);
    if (!Array.isArray(candidates)) continue;
    for (const candidate of candidates) {
      if (!Array.isArray(candidate)) continue;
      const id = str(candidate[0]);
      const rich = candidate[12];
      const images = at(field(rich, 7), [0]);
      if (Array.isArray(images)) for (const image of images) {
        const url = str(at(image, [0, 3, 3]));
        if (url) add(url, id, "image/png");
      }
      const video = str(at(field(rich, 59), [0, 0, 0, 0, 7, 1]));
      if (video) add(video, id, "video/mp4");
      const media = field(rich, 86);
      const audio = str(at(media, [0, 1, 7, 1]));
      const musicVideo = str(at(media, [1, 1, 7, 1]));
      if (audio) add(audio, id, "audio/mpeg");
      if (musicVideo) add(musicVideo, id, "video/mp4");
      // Named download/export descriptors (Canvas, research, future media variants).
      for (const value of candidate) if (value && typeof value === "object" && !Array.isArray(value)) visit(value, id);
    }
  }
  return { candidates: out, inline };
}

function field(container: unknown, index: number): unknown {
  if (!Array.isArray(container)) return asObject(container)[String(index + 1)];
  return container[index] ?? asObject(container.at(-1))[String(index + 1)];
}
function at(value: unknown, path: number[]): unknown {
  for (const index of path) { if (!Array.isArray(value)) return null; value = value[index]; }
  return value;
}
function str(value: unknown): string | null { return typeof value === "string" && value ? value : null; }
function downloadable(url: string): boolean { return /^(https:\/\/|blob:|\/(?!\/))/.test(url); }
function providerMediaUrl(url: string): boolean {
  if (/^(blob:|data:(image|audio|video)\/)/.test(url)) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && (parsed.hostname.endsWith(".googleusercontent.com")
      || parsed.hostname.endsWith(".googlevideo.com") || parsed.hostname === "googleusercontent.com");
  } catch { return false; }
}
