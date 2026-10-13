import type { Block } from "../schema/types";
import { unknownBlock, type PartLocation } from "./parts";

/** Canvas calls contain user-facing content, unlike ordinary tool inputs. */
export function blocksFromCanvas(recipient: string | null, content: any, messageId: string, loc: PartLocation): Block[] {
  if (recipient !== "canmore.create_textdoc") return [];
  const opaque = () => [unknownBlock(content, loc, recipient)];
  const text = content?.content_type === "code" && typeof content.text === "string" ? content.text
    : content?.content_type === "text" && Array.isArray(content.parts)
      ? content.parts.filter((part: unknown) => typeof part === "string").join("\n") : "";
  let input: any;
  try { input = JSON.parse(text); } catch { return opaque(); }
  if (!input || typeof input !== "object" || Array.isArray(input)) return opaque();
  if (typeof input.name !== "string" || typeof input.content !== "string" ||
      !(input.type === "document" || typeof input.type === "string" && /^code\/.+/.test(input.type))) return opaque();
  return [{ type: "artifact", artifact_id: messageId, kind: input.type === "document" ? "document" : "code",
    language: input.type === "document" ? null : input.type.slice(5), title: input.name,
    content: input.content, version: null, operation: "create" }];
}
