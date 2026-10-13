// src/schema/types.ts
export type Source = "chatgpt" | "claude" | "gemini";
export type CaptureMethod = "export" | "api" | "takeout";
export type Role = "user" | "assistant" | "system" | "tool";

/** Canonical version; the extension's raw envelope remains version 1. */
export const SCHEMA_VERSION = 2;

export interface MediaReference {
  pointer: string;
  filename: string | null;
  local_path: string | null;
  sha256?: string | null;
  mime_type?: string | null;
}

export type Block =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string; summary?: boolean }
  // Deprecated input/output fields allow historical canonical files to load.
  | { type: "tool_call"; name: string; tool_type?: string; input?: unknown }
  | { type: "tool_result"; name: string; output?: unknown }
  | { type: "artifact"; artifact_id: string; kind: string; title: string | null; version: string | null; content: string;
      language?: string | null; operation?: string; previous_version?: string | null;
      edits?: Array<{ old_str: string; new_str: string }>;
      updates?: Array<{ pattern: string; replacement: string; multiple?: boolean }>;
      comments?: Array<{ pattern: string; comment: string }> }
  | ({ type: "attachment"; kind: "image" | "audio" | "file" } & MediaReference)
  | ({ type: "image" | "audio" | "video" | "file" } & MediaReference)
  | { type: "citation"; provider_type: string; url: string | null; title: string | null; text: string | null }
  | { type: "ui_widget"; kind: string; pointer: string }
  | { type: "unknown"; provider_type: string; raw_json: unknown; raw_ref: string; raw_path: string;
      truncated: boolean; size_bytes: number };

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
