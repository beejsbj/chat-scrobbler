// src/schema/types.ts
export type Source = "chatgpt" | "claude" | "gemini";
export type CaptureMethod = "export" | "api" | "takeout";
export type Role = "user" | "assistant" | "system" | "tool";

export type Block =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "tool_result"; name: string; output: unknown }
  | { type: "artifact"; artifact_id: string; kind: string; title: string | null; version: string | null; content: string }
  | { type: "attachment"; kind: "image" | "audio" | "file"; filename: string | null; pointer: string; local_path: string | null };

export interface Message {
  id: string;
  role: Role;
  created_at: string | null;
  parent_id: string | null;
  model: string | null;
  blocks: Block[];
  /** Derived field: renderText(blocks). Parsers MUST keep this in sync with blocks. */
  text: string;
}

export interface Session {
  id: string;
  source: Source;
  source_id: string;
  capture_method: CaptureMethod;
  title: string | null;
  created_at: string;
  updated_at: string;
  default_model: string | null;
  account: string | null;
  messages: Message[];
  /** Optional: id of the message at the tip of the currently selected branch.
   *  When set and present in messages[], activePath() walks parent_id to root.
   *  Legacy sessions without this field fall back to messages[] as-is. */
  active_leaf_id?: string | null;
  raw_ref: string;
  schema_version: number;
}

export function makeSessionId(source: Source, sourceId: string): string {
  return `${source}:${sourceId}`;
}
