import { isGeminiMetadata } from "./gemini-metadata";
import type { Block } from "../schema/types";
import { childLocation, unknownBlock, type PartLocation } from "./parts";

/** No content at all: null, or arrays holding only such slots (`[]`, `[[]]`, `[[null, []]]`). */
const isEmptySlot = (value: unknown): boolean => value == null || (Array.isArray(value) && value.every(isEmptySlot));

/** Positional hNvQHb data has no public content contract. Decode only verified text. */
export function geminiTextParts(value: unknown, loc: PartLocation): Block[] {
  if (!Array.isArray(value)) return value == null ? [] : [unknownBlock(value, loc, "gemini.parts")];
  return value.flatMap((part, i): Block[] => typeof part === "string"
    ? part.trim() ? [{ type: "text", text: part.trim() }] : []
    : isEmptySlot(part) ? [] : [unknownBlock(part, childLocation(loc, i), "gemini.part")]);
}

export function geminiOpaqueSlots(value: unknown[], known: number[], loc: PartLocation, prefix: string): Block[] {
  // A bare number or boolean slot is a counter or flag, never readable content. Strings and non-empty arrays still alert.
  return value.flatMap((part, i): Block[] => known.includes(i) || isEmptySlot(part) || typeof part === "number" || typeof part === "boolean"
    || isGeminiMetadata(prefix, i, part)
    ? [] : [unknownBlock(part, childLocation(loc, i), `${prefix}.content`)]);
}

export function geminiCandidates(turn: unknown[], loc: PartLocation, keepEmpty: (id: string) => boolean = () => false): Array<{ id: string; blocks: Block[] }> {
  const resp = turn[3];
  if (!Array.isArray(resp) || !Array.isArray(resp[0])) return [];
  return resp[0].flatMap((candidate, i) => {
    if (!Array.isArray(candidate) || typeof candidate[0] !== "string") return [];
    const at = childLocation(loc, 3, 0, i);
    const blocks = [...geminiTextParts(candidate[1], childLocation(at, 1)),
      ...geminiOpaqueSlots(candidate, [0, 1], at, "gemini.candidate")];
    return blocks.length || keepEmpty(candidate[0]) ? [{ id: candidate[0], blocks }] : [];
  });
}
