import { test, expect } from "bun:test";
import { DEFAULT_CONFIG, type ChatHistoryConfig } from "../src/config";
import { runDoctor, type DoctorInspectIndexResult } from "../src/cli/commands";

type FetchResult = {
  ok: boolean;
  status: number;
  headers?: Record<string, string>;
  body?: string;
};

function cfgWith(overrides: Partial<ChatHistoryConfig> = {}): ChatHistoryConfig {
  return {
    ...DEFAULT_CONFIG,
    canonicalDir: "/tmp/chat-scrobbler/canonical",
    indexPath: "/tmp/chat-scrobbler/index.db",
    ingestBaseUrl: "http://127.0.0.1:4318",
    mcpHttpPort: 4319,
    mcpAuthToken: "mcp-token",
    ingestToken: "ingest-token",
    embeddingProvider: "none",
    mcpPublicBaseUrl: null,
    ...overrides,
  };
}

function response(result: FetchResult): Response {
  return new Response(result.body ?? "", {
    status: result.status,
    headers: result.headers ?? {},
  });
}

function makeDoctor(overrides: {
  cfg?: ChatHistoryConfig;
  configPath?: string | null;
  exists?: boolean;
  index?: DoctorInspectIndexResult;
  fetches?: Record<string, FetchResult | Error>;
} = {}) {
  const cfg = overrides.cfg ?? cfgWith();
  const out: string[] = [];
  return {
    cfg,
    out,
    run: () =>
      runDoctor({
        cfg,
        configPath: overrides.configPath ?? "/tmp/chat-scrobbler/config.json",
        write: (s) => out.push(s),
        existsSync: () => overrides.exists ?? true,
        inspectIndex: async () => overrides.index ?? { exists: true, sessionCount: 2, embeddingCount: 0 },
        fetch: async (url, init) => {
          const key = `${init?.method ?? "GET"} ${url}`;
          const result = overrides.fetches?.[key];
          if (result instanceof Error) throw result;
          return response(result ?? { ok: true, status: 200, headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","result":{}}' });
        },
      }),
  };
}

test("runDoctor passes when every required live check passes", async () => {
  const { run, out } = makeDoctor({
    cfg: cfgWith({
      embeddingProvider: "gemini",
      geminiApiKey: "gemini-key",
      mcpPublicBaseUrl: "https://chat-history.example.com",
    }),
    index: { exists: true, sessionCount: 3, embeddingCount: 7 },
  });

  const result = await run();

  expect(result.exitCode).toBe(0);
  expect(result.ok).toBe(true);
  const text = out.join("\n");
  expect(text).toContain("PASS config: /tmp/chat-scrobbler/config.json");
  expect(text).toContain("PASS mcpAuthToken");
  expect(text).toContain("PASS ingest health");
  expect(text).toContain("PASS MCP HTTP");
  expect(text).toContain("PASS embedding provider: gemini API key present");
  expect(text).toContain("PASS embeddings coverage: 7 rows");
  expect(text).toContain("PASS index: 3 sessions");
  expect(text).toContain("PASS public MCP");
});

test("runDoctor fails when mcpAuthToken is missing", async () => {
  const { run, out } = makeDoctor({ cfg: cfgWith({ mcpAuthToken: null }) });

  const result = await run();

  expect(result.exitCode).toBe(1);
  expect(out.join("\n")).toContain("FAIL mcpAuthToken");
});

test("runDoctor fails when ingest health is unreachable", async () => {
  const { run, out } = makeDoctor({
    fetches: {
      "GET http://127.0.0.1:4318/health": new Error("connection refused"),
    },
  });

  const result = await run();

  expect(result.exitCode).toBe(1);
  expect(out.join("\n")).toContain("FAIL ingest health");
});

test("runDoctor fails when local MCP does not return a structured response", async () => {
  const { run, out } = makeDoctor({
    fetches: {
      "GET http://127.0.0.1:4319/mcp/mcp-token": { ok: true, status: 200, body: "not json" },
    },
  });

  const result = await run();

  expect(result.exitCode).toBe(1);
  expect(out.join("\n")).toContain("FAIL MCP HTTP");
});

test("runDoctor warns without failing when semantic recall is dormant", async () => {
  const { run, out } = makeDoctor({ cfg: cfgWith({ embeddingProvider: "none" }) });

  const result = await run();

  expect(result.exitCode).toBe(0);
  expect(out.join("\n")).toContain("WARN embedding provider: none, semantic recall dormant");
});

test("runDoctor fails when configured Ollama model is absent", async () => {
  const { run, out } = makeDoctor({
    cfg: cfgWith({ embeddingProvider: "ollama", embeddingModel: "mxbai-embed-large" }),
    fetches: {
      "GET http://127.0.0.1:11434/api/tags": {
        ok: true,
        status: 200,
        headers: { "content-type": "application/json" },
        body: '{"models":[{"name":"nomic-embed-text"}]}',
      },
    },
  });

  const result = await run();

  expect(result.exitCode).toBe(1);
  expect(out.join("\n")).toContain("FAIL embedding provider: ollama model mxbai-embed-large missing");
});

test("runDoctor fails when Gemini is configured without an API key", async () => {
  const { run, out } = makeDoctor({ cfg: cfgWith({ embeddingProvider: "gemini", geminiApiKey: null }) });

  const result = await run();

  expect(result.exitCode).toBe(1);
  expect(out.join("\n")).toContain("FAIL embedding provider: gemini API key missing");
});

test("runDoctor warns when embeddings are configured but coverage is empty", async () => {
  const { run, out } = makeDoctor({
    cfg: cfgWith({ embeddingProvider: "hash" }),
    index: { exists: true, sessionCount: 2, embeddingCount: 0 },
  });

  const result = await run();

  expect(result.exitCode).toBe(0);
  expect(out.join("\n")).toContain("WARN embeddings coverage: 0 rows, run chat-scrobbler unify");
});

test("runDoctor fails when the index is missing", async () => {
  const { run, out } = makeDoctor({ index: { exists: false, sessionCount: 0, embeddingCount: 0 } });

  const result = await run();

  expect(result.exitCode).toBe(1);
  expect(out.join("\n")).toContain("FAIL index");
});

test("runDoctor fails when public MCP base URL is configured but unreachable", async () => {
  const { run, out } = makeDoctor({
    cfg: cfgWith({ mcpPublicBaseUrl: "https://chat-history.example.com" }),
    fetches: {
      "GET https://chat-history.example.com/mcp/mcp-token": new Error("dead tunnel"),
    },
  });

  const result = await run();

  expect(result.exitCode).toBe(1);
  expect(out.join("\n")).toContain("FAIL public MCP");
});

test("runDoctor reports defaults-only config discovery without failing", async () => {
  const { run, out } = makeDoctor({ configPath: null });

  const result = await run();

  expect(result.exitCode).toBe(0);
  expect(out.join("\n")).toContain("PASS config: defaults only");
});
