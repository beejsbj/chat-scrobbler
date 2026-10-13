import type { EmbeddingProvider } from "./sqlite";

export interface SemanticStatus {
  semantic: "available" | "unavailable" | "disabled";
  reason?: string;
  embedding_failures: number;
}
const states = new WeakMap<EmbeddingProvider, SemanticStatus>();

export function embeddingStatus(provider: EmbeddingProvider | null): SemanticStatus {
  if (!provider) return { semantic: "disabled", embedding_failures: 0 };
  return { ...(states.get(provider) ?? { semantic: "unavailable", reason: "embedding_not_checked", embedding_failures: 0 }) };
}

export function embeddingFailed(provider: EmbeddingProvider, reason: string): void {
  const state: SemanticStatus = { semantic: "unavailable", reason, embedding_failures: embeddingStatus(provider).embedding_failures + 1 };
  states.set(provider, state);
  // Provider errors can contain keys, URLs, response bodies, and chat text.
  console.error(JSON.stringify({ event: "embedding_failed", reason, failures: state.embedding_failures }));
}

export function embeddingSucceeded(provider: EmbeddingProvider): void {
  states.set(provider, { semantic: "available", embedding_failures: embeddingStatus(provider).embedding_failures });
}

export function validateEmbedding(vector: number[]): number[] {
  if (!Array.isArray(vector) || vector.length === 0 || !vector.every(value => typeof value === "number" && Number.isFinite(value))) throw new Error("invalid embedding vector");
  return vector;
}
