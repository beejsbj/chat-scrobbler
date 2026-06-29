import { afterEach, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config";
import {
  GeminiEmbeddingProvider,
  OllamaEmbeddingProvider,
  embeddingProviderFromConfig,
} from "../src/indexer/embedding-providers";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("embeddingProviderFromConfig returns null unless semantic recall is enabled", () => {
  expect(embeddingProviderFromConfig(DEFAULT_CONFIG)).toBeNull();
});

test("embeddingProviderFromConfig builds the selected providers", () => {
  expect(embeddingProviderFromConfig({
    ...DEFAULT_CONFIG,
    embeddingProvider: "gemini",
    embeddingModel: "gemini-embedding-2",
    geminiApiKey: "key",
  })).toBeInstanceOf(GeminiEmbeddingProvider);

  expect(embeddingProviderFromConfig({
    ...DEFAULT_CONFIG,
    embeddingProvider: "ollama",
    embeddingModel: "mxbai-embed-large",
  })).toBeInstanceOf(OllamaEmbeddingProvider);
});

test("GeminiEmbeddingProvider uses Gemini embedContent with retrieval prefixes", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ embedding: { values: [0.1, 0.2, 0.3] } }), { status: 200 });
  }) as typeof fetch;

  const provider = new GeminiEmbeddingProvider({ apiKey: "key-123", model: "gemini-embedding-2" });
  await expect(provider.embed("where was the water filter idea?", { kind: "query" })).resolves.toEqual([0.1, 0.2, 0.3]);
  await provider.embed("water filters and daily notes", { kind: "document", title: "Recall" });

  expect(calls[0].url).toContain("/models/gemini-embedding-2:embedContent");
  expect((calls[0].init?.headers as Record<string, string>)["x-goog-api-key"]).toBe("key-123");
  expect(JSON.parse(calls[0].init?.body as string).content.parts[0].text).toBe(
    "task: search result | query: where was the water filter idea?",
  );
  expect(JSON.parse(calls[1].init?.body as string).content.parts[0].text).toBe(
    "title: Recall | text: water filters and daily notes",
  );
});

test("OllamaEmbeddingProvider uses local /api/embed", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ embeddings: [[1, 2, 3]] }), { status: 200 });
  }) as typeof fetch;

  const provider = new OllamaEmbeddingProvider({ baseUrl: "http://127.0.0.1:11434/", model: "mxbai-embed-large" });
  await expect(provider.embed("local recall")).resolves.toEqual([1, 2, 3]);

  expect(calls[0].url).toBe("http://127.0.0.1:11434/api/embed");
  expect(JSON.parse(calls[0].init?.body as string)).toEqual({
    model: "mxbai-embed-large",
    input: "local recall",
  });
});
