import type { EmbeddingProvider } from "./sqlite";

export interface SemanticStatus {
  semantic: "available" | "unavailable" | "disabled";
  reason?: string;
  embedding_failures: number;
}
export type EmbeddingScope = "ingest" | "mcp";
const states = new WeakMap<EmbeddingProvider, Partial<Record<EmbeddingScope, SemanticStatus>>>();

export function embeddingStatus(provider: EmbeddingProvider | null, scope: EmbeddingScope = "mcp"): SemanticStatus {
  if (!provider) return { semantic: "disabled", embedding_failures: 0 };
  return { ...(states.get(provider)?.[scope] ?? { semantic: "unavailable", reason: "embedding_not_checked", embedding_failures: 0 }) };
}

export function embeddingFailed(provider: EmbeddingProvider, reason: string, scope: EmbeddingScope = "mcp"): void {
  const state: SemanticStatus = { semantic: "unavailable", reason, embedding_failures: embeddingStatus(provider, scope).embedding_failures + 1 };
  states.set(provider, { ...states.get(provider), [scope]: state });
  // Provider errors can contain keys, URLs, response bodies, and chat text.
  console.error(JSON.stringify({ event: "embedding_failed", scope, reason, failures: state.embedding_failures }));
}

export function embeddingSucceeded(provider: EmbeddingProvider, scope: EmbeddingScope = "mcp"): void {
  states.set(provider, { ...states.get(provider), [scope]: { semantic: "available", embedding_failures: embeddingStatus(provider, scope).embedding_failures } });
}

export function validateEmbedding(vector: number[]): number[] {
  if (!Array.isArray(vector) || vector.length === 0 || !vector.every(value => typeof value === "number" && Number.isFinite(value))) throw new Error("invalid embedding vector");
  return vector;
}
