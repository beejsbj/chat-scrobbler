import { persistEmbeddingStatus } from "./embedding-status";
import { monitorStatePath } from "../monitor/state";
import type { ChatHistoryConfig, EmbeddingProviderKind } from "../config";
import type { EmbeddingProvider, EmbeddingContext } from "./sqlite";

const GEMINI_EMBED_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const EMBEDDINGGEMMA_DOCUMENT_BYTES = 8 * 1024;

export function embeddingProviderFromConfig(cfg: ChatHistoryConfig): EmbeddingProvider | null {
  const provider = configuredProvider(cfg);
  if (provider) persistEmbeddingStatus(provider, monitorStatePath(cfg.indexPath, cfg.monitorStatePath));
  return provider;
}

function configuredProvider(cfg: ChatHistoryConfig): EmbeddingProvider | null {
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
    case "embeddinggemma":
      return new EmbeddingGemmaProvider({
        baseUrl: cfg.embeddingBaseUrl,
        model: cfg.embeddingModel ?? "litert-community/embeddinggemma-2-740m-litert-lm",
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
      signal: context.signal ?? AbortSignal.timeout(10000),
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

  async embed(text: string, context: EmbeddingContext = { kind: "document" }): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: "POST",
      signal: context.signal ?? AbortSignal.timeout(10000),
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

export class EmbeddingGemmaProvider implements EmbeddingProvider {
  readonly kind: EmbeddingProviderKind = "embeddinggemma";
  readonly dimensions = 768;
  readonly baseUrl: string;
  readonly model: string;

  constructor(opts: { baseUrl: string; model: string }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.model = opts.model;
  }

  async embed(text: string, context: EmbeddingContext = { kind: "document" }): Promise<number[]> {
    const chunks = context.kind === "document" ? splitEmbeddingGemmaDocument(text) : [text];
    if (context.kind === "document") context = { ...context, title: embeddingGemmaTitle(context.title) };
    // The explicit title lets the service disambiguate delimiters inside titles.
    const title = context.kind === "document" ? { title: context.title ?? "none" } : {};
    if (chunks.length === 1) {
      return this.request({ input: formatGeminiText(text, context), input_format: "prefixed", ...title }, context);
    }
    const pooled = new Array<number>(this.dimensions).fill(0);
    const totalBytes = Buffer.byteLength(text);
    for (const chunk of chunks) {
      const vector = await this.request({ input: formatGeminiText(chunk, context), input_format: "prefixed", ...title }, context);
      const weight = Buffer.byteLength(chunk) / totalBytes;
      for (let i = 0; i < pooled.length; i++) pooled[i] += vector[i] * weight;
    }
    const length = Math.hypot(...pooled);
    return length ? pooled.map(value => value / length) : pooled;
  }

  async embedAsset(
    input: { type: "image" | "audio" | "video"; path?: string; base64?: string },
    context: EmbeddingContext = { kind: "document" },
  ): Promise<number[]> {
    return this.request({ input }, context);
  }

  private async request(body: object, context: EmbeddingContext): Promise<number[]> {
    await context.beforeRequest?.();
    context.signal?.throwIfAborted();
    // Queries share the service queue with slower document and media requests.
    const timeout = AbortSignal.timeout(120000);
    const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
    signal.throwIfAborted();
    const response = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        ...body,
        role: context.kind,
      }),
    });
    if (!response.ok) {
      const detail = await safeResponseText(response);
      throw new Error(`EmbeddingGemma embedding request failed (${response.status}): ${detail}`);
    }
    const payload = await response.json() as { data?: Array<{ embedding?: unknown }> } | null;
    signal.throwIfAborted();
    const vector = payload?.data?.[0]?.embedding;
    if (!Array.isArray(vector) || vector.length !== this.dimensions ||
      !vector.every(value => typeof value === "number" && Number.isFinite(value))) {
      throw new Error("EmbeddingGemma provider response must include exactly 768 finite numbers in data[0].embedding");
    }
    return vector;
  }
}

function embeddingGemmaTitle(title: string | null | undefined): string {
  const trimmed = title?.trim() || "none";
  let bytes = 0, capped = "";
  for (const point of trimmed) {
    const size = Buffer.byteLength(point);
    if (bytes + size > 256) break;
    capped += point;
    bytes += size;
  }
  return capped;
}

function splitEmbeddingGemmaDocument(text: string): string[] {
  if (Buffer.byteLength(text) <= EMBEDDINGGEMMA_DOCUMENT_BYTES) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start;
    let bytes = 0;
    while (end < text.length) {
      const point = text.codePointAt(end)!;
      const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
      if (bytes + size > EMBEDDINGGEMMA_DOCUMENT_BYTES) break;
      bytes += size;
      end += point > 0xffff ? 2 : 1;
    }
    if (end < text.length) {
      const head = text.slice(start, end);
      // Avoid tiny batches when a boundary occurs near the start of the window.
      for (const pattern of [/\r?\n\s*\r?\n/g, /\s+/g]) {
        const boundaries = [...head.matchAll(pattern)].map(match => match.index + match[0].length);
        const boundary = boundaries.filter(index => index >= head.length / 2).at(-1);
        if (boundary !== undefined) {
          end = start + boundary;
          break;
        }
      }
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
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
