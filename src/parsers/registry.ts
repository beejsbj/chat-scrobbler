// src/parsers/registry.ts
import type { Session, Source, CaptureMethod } from "../schema/types";
import { parseChatgpt } from "./chatgpt";
import { parseClaude } from "./claude";
import { parseGemini } from "./gemini";

export type Parser = (raw: unknown) => Session[];

const registry: Record<string, Parser> = {
  "chatgpt:api": parseChatgpt,
  "claude:api": parseClaude,
  "gemini:api": parseGemini,
};

export function getParser(source: Source, method: CaptureMethod): Parser {
  const key = `${source}:${method}`;
  const parser = registry[key];
  if (!parser) throw new Error(`No parser registered for ${key}`);
  return parser;
}
