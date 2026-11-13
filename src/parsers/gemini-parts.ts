import { isGeminiMetadata } from "./gemini-metadata";
import type { Block } from "../schema/types";
import { childLocation, unknownBlock, type PartLocation } from "./parts";
import { decodeGeminiSlot } from "./gemini-slots";
import { parseGeminiUploads, type GeminiUpload } from "./gemini-uploads";

/** No content at all: null, or arrays holding only such slots (`[]`, `[[]]`, `[[null, []]]`). */
const isEmptySlot = (value: unknown): boolean => value == null || (Array.isArray(value) && value.every(isEmptySlot));

/** Positional hNvQHb data has no public content contract. Decode only verified text. */
export function geminiTextParts(value: unknown, loc: PartLocation, uploads?: (files: GeminiUpload[]) => Block[]): Block[] {
  if (!Array.isArray(value)) return value == null ? [] : [unknownBlock(value, loc, "gemini.parts")];
  return value.flatMap((part, i): Block[] => {
    if (typeof part === "string") return part.trim() ? [{ type: "text", text: part.trim() }] : [];
    if (isEmptySlot(part)) return [];
    // Slot 4 of the user's parts lists attached files. Anything that does not read as files stays unknown.
    const files = uploads && i === 4 ? parseGeminiUploads(part) : null;
    return files ? uploads!(files) : [unknownBlock(part, childLocation(loc, i), "gemini.part")];
  });
}

export function geminiOpaqueSlots(value: unknown[], known: number[], loc: PartLocation, prefix: string): Block[] {
  // A bare number or boolean slot is a counter or flag, never readable content. Strings and non-empty arrays still alert.
  return value.flatMap((part, i): Block[] => {
    if (known.includes(i) || isEmptySlot(part) || typeof part === "number" || typeof part === "boolean" || isGeminiMetadata(prefix, i, part)) return [];
    const at = childLocation(loc, i);
    return decodeGeminiSlot(prefix, i, part, at, `${prefix}.content`) ?? [unknownBlock(part, at, `${prefix}.content`)];
  });
}

export function geminiCandidates(turn: unknown[], loc: PartLocation, keepEmpty: (id: string) => boolean = () => false): Array<{ id: string; blocks: Block[] }> {
  const resp = turn[3];
  if (!Array.isArray(resp) || !Array.isArray(resp[0])) return [];
  return resp[0].flatMap((candidate, i) => {
    if (!Array.isArray(candidate) || typeof candidate[0] !== "string") return [];
    const at = childLocation(loc, 3, 0, i);
    // Reasoning leads the answer, as it does for the other providers.
    const slots = geminiOpaqueSlots(candidate, [0, 1], at, "gemini.candidate");
    const blocks = [...slots.filter(block => block.type === "reasoning"), ...geminiTextParts(candidate[1], childLocation(at, 1)),
      ...slots.filter(block => block.type !== "reasoning")];
    return blocks.length || keepEmpty(candidate[0]) ? [{ id: candidate[0], blocks }] : [];
  });
}
