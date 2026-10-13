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
        // Tool inputs and outputs are archived in raw, excluded from recall.
        break;
      case "unknown":
        break;
      case "citation":
        parts.push([b.title, b.text, b.url].filter(Boolean).join("\n"));
        break;
      case "ui_widget":
        parts.push(`[ui: ${b.kind}]`);
        break;
      case "image":
      case "audio":
      case "video":
      case "file":
      case "attachment":
        parts.push(`[${b.type === "attachment" ? b.kind : b.type}${b.filename ? ": " + b.filename : ""}${b.local_path ? " -> " + b.local_path : ""}]`);
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
