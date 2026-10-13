import { incrementMonitorCounter, readMonitorCounter } from "../monitor/state";
import type { EmbeddingProvider } from "./sqlite";

export interface SemanticStatus {
  semantic: "available" | "unavailable" | "disabled";
  reason?: string;
  embedding_failures: number;
}
export type EmbeddingScope = "ingest" | "mcp";
const persistence = new WeakMap<EmbeddingProvider, string>();
export function persistEmbeddingStatus(provider: EmbeddingProvider, statePath: string): void {
  persistence.set(provider, statePath);
}
const states = new WeakMap<EmbeddingProvider, Partial<Record<EmbeddingScope, SemanticStatus>>>();

export function embeddingStatus(provider: EmbeddingProvider | null, scope: EmbeddingScope = "mcp"): SemanticStatus {
  if (!provider) return { semantic: "disabled", embedding_failures: 0 };
  const status = { ...(states.get(provider)?.[scope] ?? { semantic: "unavailable" as const, reason: "embedding_not_checked", embedding_failures: 0 }) };
  const path = persistence.get(provider);
  if (path) {
    try { status.embedding_failures = readMonitorCounter(path, `embedding_${scope}_failures`); }
    catch { /* The monitor separately reports unreadable state. */ }
  }
  return status;
}

export function embeddingFailed(provider: EmbeddingProvider, reason: string, scope: EmbeddingScope = "mcp"): void {
  const state: SemanticStatus = { semantic: "unavailable", reason, embedding_failures: embeddingStatus(provider, scope).embedding_failures + 1 };
  states.set(provider, { ...states.get(provider), [scope]: state });
  const path = persistence.get(provider);
  if (path) {
    try { incrementMonitorCounter(path, `embedding_${scope}_failures`); }
    catch { console.error(JSON.stringify({ event: "monitor_state_write_failed" })); }
  }
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
