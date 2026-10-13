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

for (const [name, createProvider] of [
  ["Gemini", () => new GeminiEmbeddingProvider({ apiKey: "test-only", model: "gemini-embedding-2" })],
  ["Ollama", () => new OllamaEmbeddingProvider({ baseUrl: "http://unused.example", model: "test-only" })],
] as const) {
  test(`${name} enforces its 10-second deadline on hung HTTP with a caller signal`, async () => {
    let received!: () => void;
    const entered = new Promise<void>(resolve => { received = resolve; });
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
      received();
      await blocked;
      return Response.json({ embeddings: [[1, 2, 3]] });
    } });
    const caller = new AbortController();
    const expiry = new AbortController();
    const failure = new DOMException("embedding deadline exceeded", "TimeoutError");
    const timeout = spyOn(AbortSignal, "timeout").mockImplementation(() => expiry.signal);
    globalThis.fetch = ((_url, init) => originalFetch(server.url, init)) as typeof fetch;
    const checks = Promise.allSettled([createProvider().embed("notes", {
      kind: "document", signal: caller.signal,
    })]);
    try {
      await entered;
      expect(timeout).toHaveBeenCalledWith(10000);
      expiry.abort(failure);
      expect(await checks).toEqual([{ status: "rejected", reason: failure }]);
      expect(caller.signal.aborted).toBe(false);
    } finally {
      caller.abort();
      release();
      await checks;
      timeout.mockRestore();
      server.stop(true);
    }
  });

  test(`${name} preserves parent cancellation during an HTTP request`, async () => {
    let received!: () => void;
    const entered = new Promise<void>(resolve => { received = resolve; });
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
      received();
      await blocked;
      return Response.json({ embeddings: [[1, 2, 3]] });
    } });
    const caller = new AbortController();
    const failure = new Error("caller canceled");
    globalThis.fetch = ((_url, init) => originalFetch(server.url, init)) as typeof fetch;
    const checks = Promise.allSettled([createProvider().embed("find notes", {
      kind: "query", signal: caller.signal,
    })]);
    try {
      await entered;
      caller.abort(failure);
      expect(await checks).toEqual([{ status: "rejected", reason: failure }]);
    } finally {
      caller.abort();
      release();
      await checks;
      server.stop(true);
    }
  });
}

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
    input_format: "prefixed", role: "document", title: "Recall",
  });
  expect(JSON.parse(calls[2].init?.body as string).input).toBe("title: none | text: untitled notes");
  expect(JSON.parse(calls[2].init?.body as string).title).toBe("none");
  expect(JSON.parse(calls[3].init?.body as string).input).toBe("title: none | text: null title notes");
  expect(JSON.parse(calls[3].init?.body as string).title).toBe("none");
});

test("EmbeddingGemma supplies the exact document title when it contains prefix delimiters", async () => {
  const provider = new EmbeddingGemmaProvider({ baseUrl: "http://embed.example:4320", model: "gemma-test" });
  const title = "Recall | text: 旅 | text: notes";
  const prefix = "title: Recall | text: 旅 | text: notes | text: ";
  for (const text of ["actual | text: content\n", "🙂".repeat(3000) + " | text: ending"]) {
    const calls = mockEmbeddingGemmaFetch();
    await provider.embed(text, { kind: "document", title });
    const chunks: string[] = [];
    for (const call of calls) {
      const body = JSON.parse(call.init?.body as string);
      expect(body.title).toBe(title);
      expect(body.role).toBe("document");
      expect(body.input_format).toBe("prefixed");
      expect(body.input.startsWith(prefix)).toBe(true);
      chunks.push(body.input.slice(prefix.length));
    }
    expect(calls).toHaveLength(text === "actual | text: content\n" ? 1 : 2);
    expect(chunks.join("") === text).toBe(true);
  }
});

test("EmbeddingGemma trims document titles and substitutes none for blank titles", async () => {
  const calls = mockEmbeddingGemmaFetch();
  const provider = new EmbeddingGemmaProvider({ baseUrl: "http://embed.example:4320", model: "gemma-test" });
  for (const title of ["  Recall \n", "", " \t\r\n", null, undefined]) {
    await provider.embed("notes", { kind: "document", title });
  }
  expect(calls.map(call => JSON.parse(call.init?.body as string).title)).toEqual([
    "Recall", "none", "none", "none", "none",
  ]);
  expect(calls.map(call => JSON.parse(call.init?.body as string).input)).toEqual([
    "title: Recall | text: notes", ...new Array(4).fill("title: none | text: notes"),
  ]);
});

test("EmbeddingGemma caps the title at 256 UTF-8 bytes without splitting code points in every chunk", async () => {
  const provider = new EmbeddingGemmaProvider({ baseUrl: "http://embed.example:4320", model: "gemma-test" });
  for (const [title, expected] of [
    ["x".repeat(257), "x".repeat(256)],
    ["é".repeat(129), "é".repeat(128)],
    ["a" + "🙂".repeat(64), "a" + "🙂".repeat(63)],
  ]) {
    const calls = mockEmbeddingGemmaFetch();
    await provider.embed("x".repeat(9000), { kind: "document", title });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const body = JSON.parse(call.init?.body as string);
      expect(body.title).toBe(expected);
      expect(body.input.startsWith(`title: ${expected} | text: `)).toBe(true);
      expect(body.title.includes("\ufffd")).toBe(false);
    }
  }
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

test("EmbeddingGemma batches 100 KiB Unicode and unbroken documents without losing content", async () => {
  const provider = new EmbeddingGemmaProvider({ baseUrl: "http://embed.example:4320", model: "gemma-test" });
  for (const text of ["🙂漢é".repeat(12000), "x".repeat(100 * 1024)]) {
    const calls = mockEmbeddingGemmaFetch();
    expect(Buffer.byteLength(text)).toBeGreaterThanOrEqual(100 * 1024);
    await provider.embed(text, { kind: "document", title: "旅 🙂" });
    expect(calls.length).toBeGreaterThan(1);
    const chunks: string[] = [];
    for (const call of calls) {
      const body = JSON.parse(call.init?.body as string);
      expect(body.model).toBe("gemma-test");
      expect(body.role).toBe("document");
      expect(body.input_format).toBe("prefixed");
      expect(body.input.startsWith("title: 旅 🙂 | text: ")).toBe(true);
      const chunk = body.input.slice("title: 旅 🙂 | text: ".length);
      expect(Buffer.byteLength(chunk)).toBeLessThanOrEqual(8192);
      expect(chunk.length).toBeGreaterThan(0);
      expect(chunk).not.toContain("�");
      chunks.push(chunk);
    }
    expect(chunks.join("") === text).toBe(true);
  }
});

test("EmbeddingGemma prefers paragraph then word boundaries and retains whitespace", async () => {
  const provider = new EmbeddingGemmaProvider({ baseUrl: "http://embed.example:4320", model: "gemma-test" });
  const paragraph = "a".repeat(6000) + "\r\n \r\n";
  const word = "b".repeat(7000) + " \t";
  for (const [first, rest] of [[paragraph, "word ".repeat(1000)], [word, "c".repeat(4000)]]) {
    const calls = mockEmbeddingGemmaFetch();
    await provider.embed(first + rest);
    expect(JSON.parse(calls[0].init?.body as string).input === "title: none | text: " + first).toBe(true);
    const chunks = calls.map(call => JSON.parse(call.init?.body as string).input.slice("title: none | text: ".length));
    expect(chunks.join("") === first + rest).toBe(true);
  }
});

test("EmbeddingGemma normalizes pooled vectors weighted by body UTF-8 bytes", async () => {
  let calls = 0;
  globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit) => {
    const vector = new Array(768).fill(0);
    vector[calls++] = 1;
    return new Response(JSON.stringify({ data: [{ embedding: vector }] }));
  }) as typeof fetch;
  const provider = new EmbeddingGemmaProvider({ baseUrl: "http://embed.example:4320", model: "gemma-test" });
  // 8192 bytes of accented text, then 2048 bytes of emoji: weights are 4:1.
  const vector = await provider.embed("é".repeat(4096) + "🙂".repeat(512), { kind: "document", title: "Recall" });
  expect(calls).toBe(2);
  expect(vector[0]).toBeCloseTo(4 / Math.sqrt(17), 12);
  expect(vector[1]).toBeCloseTo(1 / Math.sqrt(17), 12);
  expect(vector.slice(2)).toEqual(new Array(766).fill(0));
  expect(Math.hypot(...vector)).toBeCloseTo(1, 12);
});

test("EmbeddingGemma preserves a single request vector through the 8 KiB body limit", async () => {
  const provider = new EmbeddingGemmaProvider({ baseUrl: "http://embed.example:4320", model: "gemma-test" });
  for (const text of ["", "notes", "🙂".repeat(2048)]) {
    for (const vector of [new Array(768).fill(0), new Array(768).fill(0.25)]) {
      const calls = mockEmbeddingGemmaFetch({ data: [{ embedding: vector }] });
      await expect(provider.embed(text)).resolves.toEqual(vector);
      expect(calls).toHaveLength(1);
      expect(JSON.parse(calls[0].init?.body as string).input === "title: none | text: " + text).toBe(true);
    }
  }
  const zero = new Array(768).fill(0);
  mockEmbeddingGemmaFetch({ data: [{ embedding: zero }] });
  await expect(provider.embed("x".repeat(9000))).resolves.toEqual(zero);
});

test("EmbeddingGemma waits for each document response before issuing the next request", async () => {
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  let releaseFirst!: () => void;
  const first = new Promise<void>(resolve => { releaseFirst = resolve; });
  globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit) => {
    calls++;
    active++;
    maxActive = Math.max(maxActive, active);
    if (calls === 1) await first;
    return {
      ok: true,
      async json() {
        await Promise.resolve();
        active--;
        return { data: [{ embedding: new Array(768).fill(0.25) }] };
      },
    } as Response;
  }) as typeof fetch;
  const provider = new EmbeddingGemmaProvider({ baseUrl: "http://embed.example:4320", model: "gemma-test" });
  const pending = provider.embed("x".repeat(100 * 1024));
  await Promise.resolve();
  expect(calls).toBe(1);
  releaseFirst();
  await pending;
  expect(calls).toBe(13);
  expect(maxActive).toBe(1);
  expect(active).toBe(0);
});

test("EmbeddingGemma caller abort stops later batches even if the response succeeds", async () => {
  const controller = new AbortController();
  const failure = new Error("cancel remaining batches");
  let calls = 0;
  globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit) => {
    calls++;
    controller.abort(failure);
    return new Response(JSON.stringify({ data: [{ embedding: new Array(768).fill(0.25) }] }));
  }) as typeof fetch;
  const provider = new EmbeddingGemmaProvider({ baseUrl: "http://embed.example:4320", model: "gemma-test" });
  await expect(provider.embed("x".repeat(100 * 1024), {
    kind: "document", signal: controller.signal,
  })).rejects.toBe(failure);
  expect(calls).toBe(1);
  await expect(provider.embed("more notes", { kind: "document", signal: controller.signal })).rejects.toBe(failure);
  expect(calls).toBe(1);
});

test("EmbeddingGemma awaits the load hook before every document batch request", async () => {
  const calls = mockEmbeddingGemmaFetch();
  let hooks = 0;
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  let startSecond!: () => void;
  const first = new Promise<void>(resolve => { releaseFirst = resolve; });
  const second = new Promise<void>(resolve => { releaseSecond = resolve; });
  const secondStarted = new Promise<void>(resolve => { startSecond = resolve; });
  const context = {
    kind: "document" as const,
    async beforeRequest() {
      hooks++;
      if (hooks === 1) await first;
      else {
        startSecond();
        await second;
      }
    },
  };
  const provider = new EmbeddingGemmaProvider({ baseUrl: "http://embed.example:4320", model: "gemma-test" });
  const pending = provider.embed("x".repeat(9000), context);
  await Promise.resolve();
  expect(hooks).toBe(1);
  expect(calls).toHaveLength(0);
  releaseFirst();
  await secondStarted;
  expect(hooks).toBe(2);
  expect(calls).toHaveLength(1);
  releaseSecond();
  await pending;
  expect(calls).toHaveLength(2);
});

test("EmbeddingGemma load hook rejection prevents text and media fetching", async () => {
  const calls = mockEmbeddingGemmaFetch();
  const failure = new Error("load check failed");
  const context = { kind: "document" as const, async beforeRequest() { throw failure; } };
  const provider = new EmbeddingGemmaProvider({ baseUrl: "http://embed.example:4320", model: "gemma-test" });
  await expect(provider.embed("notes", context)).rejects.toBe(failure);
  await expect(provider.embedAsset({ type: "image", path: "/archive/image.png" }, context)).rejects.toBe(failure);
  expect(calls).toHaveLength(0);
});

test("EmbeddingGemma stops remaining batches when a later load check rejects", async () => {
  const calls = mockEmbeddingGemmaFetch();
  const failure = new Error("stop remaining batches");
  let hooks = 0;
  const context = {
    kind: "document" as const,
    async beforeRequest() { if (++hooks === 2) throw failure; },
  };
  const provider = new EmbeddingGemmaProvider({ baseUrl: "http://embed.example:4320", model: "gemma-test" });
  await expect(provider.embed("x".repeat(100 * 1024), context)).rejects.toBe(failure);
  expect(hooks).toBe(2);
  expect(calls).toHaveLength(1);
});

test("EmbeddingGemma checks cancellation after awaiting the load hook", async () => {
  const calls = mockEmbeddingGemmaFetch();
  const controller = new AbortController();
  const failure = new Error("canceled during load check");
  let hooks = 0;
  const context = {
    kind: "document" as const, signal: controller.signal,
    async beforeRequest() { hooks++; controller.abort(failure); },
  };
  const provider = new EmbeddingGemmaProvider({ baseUrl: "http://embed.example:4320", model: "gemma-test" });
  await expect(provider.embed("notes", context)).rejects.toBe(failure);
  expect(hooks).toBe(1);
  expect(calls).toHaveLength(0);
  // Even an already canceled context runs its hook before the signal check.
  await expect(provider.embed("notes", context)).rejects.toBe(failure);
  expect(hooks).toBe(2);
  expect(calls).toHaveLength(0);
});
