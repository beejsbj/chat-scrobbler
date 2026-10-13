import { afterEach, expect, spyOn, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config";
import {
  GeminiEmbeddingProvider,
  OllamaEmbeddingProvider,
  EmbeddingGemmaProvider,
  embeddingProviderFromConfig,
} from "../src/indexer/embedding-providers";

const originalFetch = globalThis.fetch;

function mockEmbeddingGemmaFetch(payload: unknown = { data: [{ embedding: new Array(768).fill(0.25) }] }, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(payload), { status });
  }) as typeof fetch;
  return calls;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("embeddingProviderFromConfig builds EmbeddingGemma with defaults and overrides", () => {
  const provider = embeddingProviderFromConfig({ ...DEFAULT_CONFIG, embeddingProvider: "embeddinggemma" });
  expect(provider).toBeInstanceOf(EmbeddingGemmaProvider);
  expect(provider?.kind).toBe("embeddinggemma");
  expect(provider?.model).toBe("litert-community/embeddinggemma-2-740m-litert-lm");
  expect(provider?.dimensions).toBe(768);
  expect((provider as EmbeddingGemmaProvider).baseUrl).toBe("http://127.0.0.1:4320");

  const custom = embeddingProviderFromConfig({
    ...DEFAULT_CONFIG,
    embeddingProvider: "embeddinggemma",
    embeddingBaseUrl: "http://embed.example:9000///",
    embeddingModel: "custom-model",
  }) as EmbeddingGemmaProvider;
  expect(custom.baseUrl).toBe("http://embed.example:9000");
  expect(custom.model).toBe("custom-model");
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

test("EmbeddingGemma sends prefixed text with role and model to /v1/embeddings", async () => {
  const vector = Array.from({ length: 768 }, (_, i) => (i - 384) / 768);
  const calls = mockEmbeddingGemmaFetch({ data: [{ embedding: vector }, { embedding: [999] }] });
  const provider = new EmbeddingGemmaProvider({ baseUrl: "http://embed.example:4320/", model: "gemma-test" });
  await expect(provider.embed("find the filter", { kind: "query" })).resolves.toEqual(vector);
  await provider.embed("water filter notes", { kind: "document", title: "Recall" });
  await provider.embed("untitled notes");
  await provider.embed("null title notes", { kind: "document", title: null });

  expect(calls[0].url).toBe("http://embed.example:4320/v1/embeddings");
  expect(calls[0].init?.method).toBe("POST");
  expect(calls[0].init?.headers).toEqual({ "content-type": "application/json" });
  expect(JSON.parse(calls[0].init?.body as string)).toEqual({
    model: "gemma-test", input: "task: search result | query: find the filter",
    input_format: "prefixed", role: "query",
  });
  expect(JSON.parse(calls[1].init?.body as string)).toEqual({
    model: "gemma-test", input: "title: Recall | text: water filter notes",
    input_format: "prefixed", role: "document",
  });
  expect(JSON.parse(calls[2].init?.body as string).input).toBe("title: none | text: untitled notes");
  expect(JSON.parse(calls[3].init?.body as string).input).toBe("title: none | text: null title notes");
});

test("EmbeddingGemma sends image, audio, and video objects without text prefixes", async () => {
  const calls = mockEmbeddingGemmaFetch();
  const provider = new EmbeddingGemmaProvider({ baseUrl: "http://embed.example:4320", model: "gemma-test" });
  const image = { type: "image" as const, path: "/archive/image.png" };
  const audio = { type: "audio" as const, base64: "YXVkaW8=" };
  const video = { type: "video" as const, path: "/archive/video.mp4" };
  await expect(provider.embedAsset(image)).resolves.toHaveLength(768);
  await provider.embedAsset(audio, { kind: "query" });
  await provider.embedAsset(video, { kind: "document", title: "Trip" });

  for (const call of calls) {
    expect(call.url).toBe("http://embed.example:4320/v1/embeddings");
    expect(call.init?.method).toBe("POST");
    expect(call.init?.headers).toEqual({ "content-type": "application/json" });
  }
  expect(JSON.parse(calls[0].init?.body as string)).toEqual({ model: "gemma-test", input: image, role: "document" });
  expect(JSON.parse(calls[1].init?.body as string)).toEqual({ model: "gemma-test", input: audio, role: "query" });
  expect(JSON.parse(calls[2].init?.body as string)).toEqual({ model: "gemma-test", input: video, role: "document" });
});

test("EmbeddingGemma rejects malformed, nonnumeric, and wrong-sized vectors for text and media", async () => {
  const provider = new EmbeddingGemmaProvider({ baseUrl: "http://embed.example:4320", model: "gemma-test" });
  const malformedPayloads = [
    null, {}, { data: [] }, { data: [{}] },
    { embedding: { values: new Array(768).fill(1) } },
    { data: [{ embedding: "not a vector" }] },
    { data: [{ embedding: [] }] },
    { data: [{ embedding: new Array(767).fill(1) }] },
    { data: [{ embedding: new Array(769).fill(1) }] },
    ...["0.25", null, true, {}, NaN, Infinity, -Infinity].map(value => ({
      data: [{ embedding: [...new Array(767).fill(1), value] }],
    })),
  ];
  for (const payload of malformedPayloads) {
    mockEmbeddingGemmaFetch(payload);
    await expect(provider.embed("notes")).rejects.toThrow("768 finite numbers");
    await expect(provider.embedAsset({ type: "image", path: "/archive/image.png" })).rejects.toThrow("768 finite numbers");
  }
  // A JSON parser can also overflow a valid JSON numeric literal to infinity.
  globalThis.fetch = (async (_url: string | URL | Request) => new Response(
    `{"data":[{"embedding":[${new Array(767).fill("1").join(",")},1e400]}]}`,
  )) as typeof fetch;
  await expect(provider.embed("notes")).rejects.toThrow("768 finite numbers");
});

test("EmbeddingGemma reports HTTP failures and preserves transport failures", async () => {
  const provider = new EmbeddingGemmaProvider({ baseUrl: "http://embed.example:4320", model: "gemma-test" });
  mockEmbeddingGemmaFetch({ error: "queue unavailable" }, 503);
  await expect(provider.embed("notes")).rejects.toThrow("EmbeddingGemma embedding request failed (503)");
  await expect(provider.embedAsset({ type: "audio", base64: "YXVkaW8=" })).rejects.toThrow("queue unavailable");

  const failure = new Error("connection refused");
  globalThis.fetch = (async (_url: string | URL | Request): Promise<Response> => { throw failure; }) as typeof fetch;
  await expect(provider.embed("notes")).rejects.toBe(failure);
});

test("EmbeddingGemma allows 120 seconds for queued queries, documents, and media", async () => {
  const calls = mockEmbeddingGemmaFetch();
  const timeouts: number[] = [];
  const signals: AbortSignal[] = [];
  const timeout = spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    timeouts.push(ms);
    const signal = new AbortController().signal;
    signals.push(signal);
    return signal;
  });
  try {
    const provider = new EmbeddingGemmaProvider({ baseUrl: "http://embed.example:4320", model: "gemma-test" });
    await provider.embed("find notes", { kind: "query" });
    await provider.embed("notes");
    await provider.embedAsset({ type: "image", path: "/archive/image.png" });
    await provider.embedAsset({ type: "audio", base64: "YXVkaW8=" });
    await provider.embedAsset({ type: "video", path: "/archive/video.mp4" });
    expect(timeouts).toEqual([120000, 120000, 120000, 120000, 120000]);
    for (let i = 0; i < calls.length; i++) expect(calls[i].init?.signal).toBe(signals[i]);
  } finally {
    timeout.mockRestore();
  }
});

test("EmbeddingGemma honors caller cancellation for text and media", async () => {
  mockEmbeddingGemmaFetch();
  const provider = new EmbeddingGemmaProvider({ baseUrl: "http://embed.example:4320", model: "gemma-test" });
  const controller = new AbortController();
  const failure = new Error("caller canceled");
  globalThis.fetch = ((_url, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    if (signal?.aborted) reject(signal.reason);
    else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  })) as typeof fetch;

  const text = provider.embed("find notes", { kind: "query", signal: controller.signal });
  const media = provider.embedAsset({ type: "image", path: "/archive/image.png" }, {
    kind: "document", signal: controller.signal,
  });
  const checks = Promise.allSettled([text, media]);
  controller.abort(failure);
  expect(await checks).toEqual([
    { status: "rejected", reason: failure },
    { status: "rejected", reason: failure },
  ]);
});

test("EmbeddingGemma times out text and media even with a caller signal", async () => {
  const expiry = new AbortController();
  const caller = new AbortController();
  const failure = new DOMException("embedding deadline exceeded", "TimeoutError");
  const timeout = spyOn(AbortSignal, "timeout").mockImplementation(() => expiry.signal);
  globalThis.fetch = ((_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  })) as typeof fetch;
  try {
    const provider = new EmbeddingGemmaProvider({ baseUrl: "http://embed.example:4320", model: "gemma-test" });
    const checks = Promise.allSettled([
      provider.embed("find notes", { kind: "query", signal: caller.signal }),
      provider.embedAsset({ type: "video", path: "/archive/video.mp4" }, {
        kind: "document", signal: caller.signal,
      }),
    ]);
    expiry.abort(failure);
    expect(await checks).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
    expect(caller.signal.aborted).toBe(false);
  } finally {
    timeout.mockRestore();
  }
});
