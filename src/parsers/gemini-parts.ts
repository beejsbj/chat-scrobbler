import type { Block } from "../schema/types";
import { childLocation, unknownBlock, type PartLocation } from "./parts";

/** Positional hNvQHb data has no public content contract. Decode only verified text. */
export function geminiTextParts(value: unknown, loc: PartLocation): Block[] {
  if (!Array.isArray(value)) return value == null ? [] : [unknownBlock(value, loc, "gemini.parts")];
  return value.flatMap((part, i): Block[] => typeof part === "string"
    ? part.trim() ? [{ type: "text", text: part.trim() }] : []
    : [unknownBlock(part, childLocation(loc, i), "gemini.part")]);
}

// Slots verified as control, locale, branding, suggestion or status metadata in
// gemini-api-sample.json. Their bytes stay in raw. Objects in these slots are
// not part of the verified metadata shape and must still be retained.
const METADATA: Record<string, number[]> = {
  "gemini.user": [1, 3, 4, 5, 8],
  "gemini.candidate": [6, 8, 9, 12, 15, 21, 27, 37, 44],
  "gemini.response": [1, 8, 14, 17, 24, 25],
  "gemini.payload": [1, 2, 3],
};
function metadataValue(value: unknown, depth = 0): boolean {
  if (value == null || ["string", "number", "boolean"].includes(typeof value)) return true;
  return depth < 32 && Array.isArray(value) && value.every(item => metadataValue(item, depth + 1));
}

export function geminiOpaqueSlots(value: unknown[], known: number[], loc: PartLocation, prefix: string): Block[] {
  return value.flatMap((part, i): Block[] => known.includes(i) || part == null || (Array.isArray(part) && !part.length)
    || (METADATA[prefix]?.includes(i) && metadataValue(part))
    ? [] : [unknownBlock(part, childLocation(loc, i), `${prefix}.content`)]);
}

export function geminiCandidates(turn: unknown[], loc: PartLocation): Array<{ id: string; blocks: Block[] }> {
  const resp = turn[3];
  if (!Array.isArray(resp) || !Array.isArray(resp[0])) return [];
  return resp[0].flatMap((candidate, i) => {
    if (!Array.isArray(candidate) || typeof candidate[0] !== "string") return [];
    const at = childLocation(loc, 3, 0, i);
    const blocks = [...geminiTextParts(candidate[1], childLocation(at, 1)),
      ...geminiOpaqueSlots(candidate, [0, 1], at, "gemini.candidate")];
    return blocks.length ? [{ id: candidate[0], blocks }] : [];
  });
}
