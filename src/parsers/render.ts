import type { Block } from "../schema/types";

export function renderText(blocks: Block[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case "text":
      case "reasoning":
        parts.push(b.text);
        break;
      case "artifact":
        parts.push([b.title, b.content].filter(Boolean).join("\n"));
        break;
      case "tool_call":
        parts.push(`[tool: ${b.name}]`);
        break;
      case "tool_result":
        if (b.output == null) break;
        parts.push(typeof b.output === "string" ? b.output : JSON.stringify(b.output));
        break;
      case "attachment":
        parts.push(`[${b.kind}${b.filename ? ": " + b.filename : ""}]`);
        break;
      default: {
        const _exhaustive: never = b;
        void _exhaustive;
        break;
      }
    }
  }
  return parts.join("\n\n").trim();
}
