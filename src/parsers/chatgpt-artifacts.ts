import type { Block } from "../schema/types";
import { unknownBlock, type PartLocation } from "./parts";

export type CanvasArtifact = Extract<Block, { type: "artifact" }>;
type Update = NonNullable<CanvasArtifact["updates"]>[number];
type Comment = NonNullable<CanvasArtifact["comments"]>[number];

/** Only ancestor artifacts can supply context to an edit on this branch. */
export function canvasAncestor(parent: string | null, mapping: Record<string, { parent: string | null }>,
  artifacts: Map<string, CanvasArtifact>): CanvasArtifact | undefined {
  const seen = new Set<string>();
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    const artifact = artifacts.get(parent);
    if (artifact) return artifact;
    parent = mapping[parent]?.parent ?? null;
  }
}

/** Canvas calls contain user-facing content, unlike ordinary tool inputs. */
export function blocksFromCanvas(recipient: string | null, content: any, messageId: string,
  loc: PartLocation, prior?: CanvasArtifact): Block[] {
  if (!recipient?.startsWith("canmore.")) return [];
  // Other content envelopes are already preserved by blocksFromContent.
  if (!["code", "text"].includes(content?.content_type)) return [];
  const opaque = () => [unknownBlock(content, loc, recipient)];
  const text = content?.content_type === "code" && typeof content.text === "string" ? content.text
    : content?.content_type === "text" && Array.isArray(content.parts)
      ? content.parts.filter((part: unknown) => typeof part === "string").join("\n") : "";
  let input: any;
  try { input = JSON.parse(text); } catch { return opaque(); }
  if (!input || typeof input !== "object" || Array.isArray(input)) return opaque();
  const artifact: CanvasArtifact = { type: "artifact", artifact_id: prior?.artifact_id ?? messageId,
    kind: prior?.kind ?? "", language: prior?.language ?? null, title: prior?.title ?? null, content: "", version: null };
  switch (recipient) {
    case "canmore.create_textdoc":
      if (typeof input.name !== "string" || typeof input.content !== "string" ||
          !(input.type === "document" || typeof input.type === "string" && /^code\/.+/.test(input.type))) return opaque();
      Object.assign(artifact, { artifact_id: messageId, kind: input.type === "document" ? "document" : "code",
        language: input.type === "document" ? null : input.type.slice(5), title: input.name,
        content: input.content, operation: "create" });
      break;
    case "canmore.update_textdoc":
      if (!Array.isArray(input.updates) || !input.updates.every((edit: any) => edit &&
          typeof edit.pattern === "string" && typeof edit.replacement === "string" &&
          (edit.multiple === undefined || typeof edit.multiple === "boolean"))) return opaque();
      artifact.operation = "update";
      const updates: Update[] = input.updates.map((edit: Update) => ({ pattern: edit.pattern, replacement: edit.replacement,
        ...(edit.multiple === undefined ? {} : { multiple: edit.multiple }) }));
      artifact.updates = updates;
      artifact.content = updates.map(edit => edit.replacement).join("\n");
      break;
    case "canmore.comment_textdoc":
      if (!Array.isArray(input.comments) || !input.comments.every((comment: any) => comment &&
          typeof comment.pattern === "string" && typeof comment.comment === "string")) return opaque();
      artifact.operation = "comment";
      const comments: Comment[] = input.comments.map((comment: Comment) => ({ pattern: comment.pattern, comment: comment.comment }));
      artifact.comments = comments;
      artifact.content = comments.map(comment => comment.comment).join("\n");
      break;
    default: return opaque();
  }
  return [artifact];
}
