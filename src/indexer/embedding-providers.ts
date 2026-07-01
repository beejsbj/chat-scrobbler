import type { ChatHistoryConfig, EmbeddingProviderKind } from "../config";
import type { EmbeddingProvider, EmbeddingContext } from "./sqlite";

const GEMINI_EMBED_URL = "https://generativelanguage.googleapis.com/v1beta/models";

export function embeddingProviderFromConfig(cfg: ChatHistoryConfig): EmbeddingProvider | null {
  switch (cfg.embeddingProvider) {
    case "none":
      return null;
    case "hash":
      return new HashEmbeddingProvider();
    case "gemini":
      return new GeminiEmbeddingProvider({
        apiKey: cfg.geminiApiKey,
        model: cfg.embeddingModel ?? "gemini-embedding-2",
      });
    case "ollama":
      return new OllamaEmbeddingProvider({
        baseUrl: cfg.ollamaBaseUrl,
        model: cfg.embeddingModel ?? "mxbai-embed-large",
      });
    default:
      assertNever(cfg.embeddingProvider);
  }
}

export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly kind: EmbeddingProviderKind = "hash";
  readonly model = "hash-v1";
  readonly dimensions = 64;

  embed(text: string): number[] {
    const vector = new Array(this.dimensions).fill(0);
    for (const token of tokenizeForEmbedding(text)) {
      const idx = hashToken(token) % this.dimensions;
      vector[idx] += 1;
    }
    return normalize(vector);
  }
}

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly kind: EmbeddingProviderKind = "gemini";
  readonly dimensions: number | null = null;
  readonly apiKey: string;
  readonly model: string;

  constructor(opts: { apiKey: string | null; model: string }) {
    if (!opts.apiKey) {
      throw new Error("CHAT_SCROBBLER_EMBED_PROVIDER=gemini requires GEMINI_API_KEY or GOOGLE_API_KEY");
    }
    this.apiKey = opts.apiKey;
    this.model = opts.model;
  }

  async embed(text: string, context: EmbeddingContext = { kind: "document" }): Promise<number[]> {
    const body = {
      model: `models/${this.model}`,
      content: {
        parts: [{ text: formatGeminiText(text, context) }],
      },
    };
    const url = `${GEMINI_EMBED_URL}/${encodeURIComponent(this.model)}:embedContent`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": this.apiKey,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = await safeResponseText(response);
      throw new Error(`Gemini embedding request failed (${response.status}): ${detail}`);
    }
    return embeddingValues(await response.json());
  }
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly kind: EmbeddingProviderKind = "ollama";
  readonly dimensions: number | null = null;
  readonly baseUrl: string;
  readonly model: string;

  constructor(opts: { baseUrl: string; model: string }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.model = opts.model;
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, input: text }),
    });
    if (!response.ok) {
      const detail = await safeResponseText(response);
      throw new Error(`Ollama embedding request failed (${response.status}): ${detail}`);
    }
    return embeddingValues(await response.json());
  }
}

function formatGeminiText(text: string, context: EmbeddingContext): string {
  if (context.kind === "query") return `task: search result | query: ${text}`;
  return `title: ${context.title ?? "none"} | text: ${text}`;
}

function embeddingValues(payload: unknown): number[] {
  const value = payload as any;
  const candidates = [
    value?.embedding?.values,
    value?.embeddings?.[0]?.values,
    value?.embeddings?.[0],
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      const vector = candidate.map(Number).filter((n) => Number.isFinite(n));
      if (vector.length > 0) return vector;
    }
  }
  throw new Error("Embedding provider response did not include a numeric vector");
}

async function safeResponseText(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  return text.slice(0, 500) || response.statusText;
}

function tokenizeForEmbedding(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function hashToken(token: string): number {
  let hash = 2166136261;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normalize(vector: number[]): number[] {
  const length = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  return length ? vector.map((v) => Number((v / length).toFixed(6))) : vector;
}

function assertNever(value: never): never {
  throw new Error(`Unsupported embedding provider: ${String(value)}`);
}
