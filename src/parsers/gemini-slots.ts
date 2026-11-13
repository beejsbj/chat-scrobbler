// Decoders for Gemini candidate slots that carry readable content. The hNvQHb arrays are positional and
// Google changes them without notice, so every step checks the layout it expects. A decoder returns null
// on any mismatch and the caller keeps the slot as an unknown block, so a layout change alerts instead of
// producing garbage. The answer text already holds what grounding annotates, so only the sources are kept.
import type { Block } from "../schema/types";
import { unknownBlock, type PartLocation } from "./parts";

type Citation = Extract<Block, { type: "citation" }>;
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
const isUrl = (value: unknown): value is string => typeof value === "string" && /^https?:\/\/\S+$/.test(value);
const isEmpty = (value: unknown): boolean => value == null || (Array.isArray(value) && value.every(isEmpty));

const cite = (provider_type: string, title: string, url: string | null, body: string | null): Citation =>
  ({ type: "citation", provider_type, url, title, text: body });

/** Keeps the first of each citation, by url or by title and text. */
function distinct(citations: Citation[]): Citation[] {
  const seen = new Set<string>();
  return citations.filter(c => { const key = c.url ?? `${c.title}\n${c.text}`; return seen.has(key) ? false : (seen.add(key), true); });
}

/** Slot 37: `[[whole], [[[section], "", "", "", [...], title, body], ...]]`. The whole text already holds every section, so it is emitted once. */
function thinkingSummary(value: unknown): Block[] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [whole, sections] = value;
  const summary = Array.isArray(whole) && whole.length === 1 ? text(whole[0]) : null;
  if (!summary || !Array.isArray(sections) || !sections.length) return null;
  // A section the whole text lacks would be lost by emitting only the whole.
  const held = sections.every(section => { const md = Array.isArray(section) && Array.isArray(section[0]) ? text(section[0][0]) : null; return !!md && summary.includes(md); });
  return held ? [{ type: "reasoning", text: summary, summary: true }] : null;
}

/** Slot 2: `[null, [[[quoted answer span, ...], [n], [[url, title, icon, snippet, ...]], label], ...]]`. */
function groundingSources(value: unknown): Block[] | null {
  if (!Array.isArray(value) || value.length !== 2 || value[0] !== null || !Array.isArray(value[1]) || !value[1].length) return null;
  const out: Citation[] = [];
  for (const entry of value[1]) {
    if (!Array.isArray(entry) || !Array.isArray(entry[2]) || !entry[2].length) return null;
    for (const source of entry[2]) {
      const title = Array.isArray(source) ? text(source[1]) : null;
      if (!Array.isArray(source) || !isUrl(source[0]) || !title || (source[3] != null && typeof source[3] !== "string")) return null;
      out.push(cite("gemini.grounding", title, source[0], text(source[3])));
    }
  }
  return distinct(out);
}

/** Slot 30: `[[card id, null x4, [null x4, [[[header], null x3, [[[title, id, watch url, channel, ...]]]]]], ...], ...]`. Only video results are known. */
function videoCards(value: unknown): Block[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  const out: Citation[] = [];
  for (const card of value) {
    const items = Array.isArray(card) && Array.isArray(card[5]) ? card[5][4] : null;
    if (!Array.isArray(items) || !items.length) return null;
    for (const item of items) {
      const header = Array.isArray(item) && Array.isArray(item[0]) && Array.isArray(item[0][6]) ? item[0][6] : [];
      const video = Array.isArray(item) && Array.isArray(item[4]) && Array.isArray(item[4][0]) ? item[4][0][0] : null;
      const title = Array.isArray(video) ? text(video[0]) : null;
      if (!Array.isArray(video) || !title || !text(video[1]) || !isUrl(video[2]) || (video[3] != null && typeof video[3] !== "string")) return null;
      if (header[3] !== "youtube" && !/^https?:\/\/(?:[\w-]+\.)?(?:youtube\.com|youtu\.be)\//.test(video[2])) return null;
      out.push(cite("gemini.youtube", title, video[2], text(video[3])));
    }
  }
  return distinct(out);
}

/** One entry of key "44": `[["[cite: n]", i], [[null, [[null, type, filename, ...], ...]]], [quoted text, i]]`. */
function fileCitation(entry: unknown): Citation | null {
  if (!Array.isArray(entry) || entry.length < 3) return null;
  const [marker, file, quote] = entry;
  if (!Array.isArray(marker) || typeof marker[0] !== "string" || !/^\[cite: \d+\]$/.test(marker[0])) return null;
  const descriptor = Array.isArray(file) && Array.isArray(file[0]) && Array.isArray(file[0][1]) ? file[0][1][0] : null;
  const name = Array.isArray(descriptor) && typeof descriptor[1] === "number" ? text(descriptor[2]) : null;
  if (!name || !Array.isArray(quote) || typeof quote[0] !== "string") return null;
  return cite("gemini.file_citation", name, null, text(quote[0]));
}

/** Slot 12: nulls and empties, then an object keyed by feature number. Key "44" holds citations of uploaded files. */
function featureObject(value: unknown, at: PartLocation, label: string): Block[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  const object = value.at(-1);
  if (!isObject(object) || !value.slice(0, -1).every(isEmpty)) return null;
  const citations: Citation[] = [];
  let residue = false;
  for (const [key, entry] of Object.entries(object)) {
    if (key === "44") {
      if (!Array.isArray(entry)) return null;
      for (const raw of entry) { const found = fileCitation(raw); if (!found) return null; citations.push(found); }
    } else if (!(isEmpty(entry) || (key === "19" && typeof entry === "number") || (key === "53" && Array.isArray(entry) && entry.every(n => typeof n === "number")))) {
      residue = true;
    }
  }
  // Something besides citations and known flags: keep the readable part and still alert on the slot.
  if (residue) return citations.length ? [...distinct(citations), unknownBlock(value, at, label)] : null;
  return distinct(citations);
}

/** Blocks for a candidate slot with a decoder, or null when the slot is unknown or its layout drifted. */
export function decodeGeminiSlot(scope: string, index: number, value: unknown, at: PartLocation, label: string): Block[] | null {
  try {
    if (scope !== "gemini.candidate") return null;
    switch (index) {
      case 2: return groundingSources(value);
      case 12: return featureObject(value, at, label);
      case 30: return videoCards(value);
      case 37: return thinkingSummary(value);
      default: return null;
    }
  } catch { return null; }
}
