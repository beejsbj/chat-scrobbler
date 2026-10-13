import { isGeminiMetadata } from "./gemini-metadata";
import type { Block } from "../schema/types";
import { childLocation, unknownBlock, type PartLocation } from "./parts";

/** Positional hNvQHb data has no public content contract. Decode only verified text. */
export function geminiTextParts(value: unknown, loc: PartLocation): Block[] {
  if (!Array.isArray(value)) return value == null ? [] : [unknownBlock(value, loc, "gemini.parts")];
  return value.flatMap((part, i): Block[] => typeof part === "string"
    ? part.trim() ? [{ type: "text", text: part.trim() }] : []
    : [unknownBlock(part, childLocation(loc, i), "gemini.part")]);
}

export function geminiOpaqueSlots(value: unknown[], known: number[], loc: PartLocation, prefix: string): Block[] {
  return value.flatMap((part, i): Block[] => known.includes(i) || part == null || (Array.isArray(part) && !part.length)
    || isGeminiMetadata(prefix, i, part)
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
