import type { ProviderAdapter, FetchLike } from "./types";
import { createChatgptAdapter } from "./chatgpt";
import { createClaudeAdapter } from "./claude";
import { createGeminiAdapter } from "./gemini";

export * from "./types";
export { createGeminiAdapter } from "./gemini";
export type { GeminiPageContext, WizData } from "./gemini";

export function detectProvider(hostname = location.hostname): ProviderAdapter | null {
  if (hostname === "chatgpt.com" || hostname === "chat.openai.com") return createChatgptAdapter();
  if (hostname === "claude.ai") return createClaudeAdapter();
  if (hostname === "gemini.google.com") return createGeminiAdapter();
  return null;
}

export function createProviderForSource(source: "chatgpt" | "claude" | "gemini", fetcher?: FetchLike): ProviderAdapter {
  if (source === "chatgpt") return createChatgptAdapter(fetcher);
  if (source === "claude") return createClaudeAdapter(fetcher);
  return createGeminiAdapter(fetcher);
}
