import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";

test("loadConfig returns data-home defaults with empty env and no config file", () => {
  const dataHome = join(homedir(), ".local", "share", "chat-scrobbler");
  const cfg = loadConfig({ env: {}, configPath: null });
  expect(cfg.canonicalDir).toBe(join(dataHome, "canonical", "sessions"));
  expect(cfg.indexPath).toBe(join(dataHome, "index", "sessions.db"));
  expect(cfg.ingestPort).toBe(4318);
  expect(cfg.mcpHttpPort).toBe(4319);
  expect(cfg.mcpAuthToken).toBeNull();
  expect(cfg.mcpPublicBaseUrl).toBeNull();
  expect(cfg.ingestToken).toBeNull();
  expect(cfg.ingestBaseUrl).toBe("http://127.0.0.1:4318");
  expect(cfg.backupTargets).toEqual([join(dataHome, "backups")]);
});

test("env overrides defaults", () => {
  const cfg = loadConfig({
    env: {
      CANONICAL_DIR: "/data/canon",
      INDEX_PATH: "/data/idx.db",
      PORT: "5000",
      MCP_HTTP_PORT: "5001",
      MCP_AUTH_TOKEN: "mcp-secret",
      MCP_PUBLIC_BASE_URL: "https://chat-history.example.com",
      INGEST_TOKEN: "secret",
      BACKUP_TARGET: "/backups/chat",
    },
    configPath: null,
  });
  expect(cfg.canonicalDir).toBe("/data/canon");
  expect(cfg.indexPath).toBe("/data/idx.db");
  expect(cfg.ingestPort).toBe(5000);
  expect(cfg.mcpHttpPort).toBe(5001);
  expect(cfg.mcpAuthToken).toBe("mcp-secret");
  expect(cfg.mcpPublicBaseUrl).toBe("https://chat-history.example.com");
  expect(cfg.ingestToken).toBe("secret");
  expect(cfg.backupTargets).toEqual(["/backups/chat"]);
  // ingestBaseUrl tracks the ingest port by default
  expect(cfg.ingestBaseUrl).toBe("http://127.0.0.1:5000");
});

test("prefixed MCP env vars override defaults", () => {
  const cfg = loadConfig({
    env: {
      CHAT_SCROBBLER_MCP_AUTH_TOKEN: "prefixed-secret",
      CHAT_SCROBBLER_MCP_PUBLIC_BASE_URL: "https://prefixed.example.com",
    },
    configPath: null,
  });
  expect(cfg.mcpAuthToken).toBe("prefixed-secret");
  expect(cfg.mcpPublicBaseUrl).toBe("https://prefixed.example.com");
});

test("explicit INGEST_BASE_URL overrides the port-derived default", () => {
  const cfg = loadConfig({
    env: { PORT: "5000", INGEST_BASE_URL: "https://host.example/ingest" },
    configPath: null,
  });
  expect(cfg.ingestBaseUrl).toBe("https://host.example/ingest");
});

test("config file overrides defaults; env overrides config file", () => {
  const dir = mkdtempSync(join(tmpdir(), "ch-config-"));
  try {
    const file = join(dir, "chat-scrobbler.config.json");
    writeFileSync(
      file,
      JSON.stringify({
        canonicalDir: "/from/file/canon",
        indexPath: "/from/file/idx.db",
        ingestPort: 6000,
        mcpAuthToken: "from-file-token",
        mcpPublicBaseUrl: "https://from-file.example.com",
      }),
    );
    const cfg = loadConfig({
      env: {
        INDEX_PATH: "/from/env/idx.db",
        MCP_AUTH_TOKEN: "from-env-token",
      },
      configPath: file,
    });
    expect(cfg.canonicalDir).toBe("/from/file/canon"); // file wins over default
    expect(cfg.ingestPort).toBe(6000); // file wins over default
    expect(cfg.indexPath).toBe("/from/env/idx.db"); // env wins over file
    expect(cfg.mcpAuthToken).toBe("from-env-token"); // env wins over file
    expect(cfg.mcpPublicBaseUrl).toBe("https://from-file.example.com"); // file wins over default
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid numeric env is ignored in favor of the default", () => {
  const cfg = loadConfig({ env: { PORT: "not-a-number" }, configPath: null });
  expect(cfg.ingestPort).toBe(4318);
});

test("a missing explicit config file is tolerated (falls back to defaults)", () => {
  const cfg = loadConfig({ env: {}, configPath: "/no/such/chat-scrobbler.config.json" });
  expect(cfg.canonicalDir).toBe(join(homedir(), ".local", "share", "chat-scrobbler", "canonical", "sessions"));
});

test("BACKUP_TARGET env accepts a comma-separated list", () => {
  const cfg = loadConfig({
    env: { BACKUP_TARGET: "/backups/local, /Volumes/nas/chat-scrobbler " },
    configPath: null,
  });
  expect(cfg.backupTargets).toEqual(["/backups/local", "/Volumes/nas/chat-scrobbler"]);
});

test("BACKUP_TARGET env ignores an empty comma-separated list", () => {
  const cfg = loadConfig({
    env: { BACKUP_TARGET: " , " },
    configPath: null,
  });
  expect(cfg.backupTargets).toEqual([join(homedir(), ".local", "share", "chat-scrobbler", "backups")]);
});

test("config file backupTargets array is honored", () => {
  const dir = mkdtempSync(join(tmpdir(), "ch-config-"));
  try {
    const file = join(dir, "chat-scrobbler.config.json");
    writeFileSync(file, JSON.stringify({ backupTargets: ["/a", "/b"] }));
    const cfg = loadConfig({ env: {}, configPath: file });
    expect(cfg.backupTargets).toEqual(["/a", "/b"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy backupTarget string in config file is wrapped into the list", () => {
  const dir = mkdtempSync(join(tmpdir(), "ch-config-"));
  try {
    const file = join(dir, "chat-scrobbler.config.json");
    writeFileSync(file, JSON.stringify({ backupTarget: "/legacy/spot" }));
    const cfg = loadConfig({ env: {}, configPath: file });
    expect(cfg.backupTargets).toEqual(["/legacy/spot"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CHAT_SCROBBLER_CONFIG env var is honored for config file discovery", () => {
  const dir = mkdtempSync(join(tmpdir(), "ch-config-"));
  try {
    const file = join(dir, "chat-scrobbler.config.json");
    writeFileSync(file, JSON.stringify({ canonicalDir: "/from/env-config/canon" }));
    const cfg = loadConfig({ env: { CHAT_SCROBBLER_CONFIG: file }, cwd: dir });
    expect(cfg.canonicalDir).toBe("/from/env-config/canon");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("embedding env config selects local and cloud providers", () => {
  const gemini = loadConfig({
    env: {
      CHAT_SCROBBLER_EMBED_PROVIDER: "gemini",
      CHAT_SCROBBLER_EMBED_MODEL: "gemini-embedding-2",
      GEMINI_API_KEY: "key-123",
    },
    configPath: null,
  });
  expect(gemini.embeddingProvider).toBe("gemini");
  expect(gemini.embeddingModel).toBe("gemini-embedding-2");
  expect(gemini.geminiApiKey).toBe("key-123");

  const ollama = loadConfig({
    env: {
      CHAT_SCROBBLER_EMBED_PROVIDER: "ollama",
      CHAT_SCROBBLER_EMBED_MODEL: "mxbai-embed-large",
      CHAT_SCROBBLER_OLLAMA_BASE_URL: "http://127.0.0.1:11434",
    },
    configPath: null,
  });
  expect(ollama.embeddingProvider).toBe("ollama");
  expect(ollama.embeddingModel).toBe("mxbai-embed-large");
  expect(ollama.ollamaBaseUrl).toBe("http://127.0.0.1:11434");
});

test("config file embeddingProvider is validated before being applied", () => {
  const dir = mkdtempSync(join(tmpdir(), "ch-config-"));
  try {
    const invalidFile = join(dir, "invalid-provider.json");
    writeFileSync(invalidFile, JSON.stringify({ embeddingProvider: "not-a-provider" }));
    expect(loadConfig({ env: {}, configPath: invalidFile }).embeddingProvider).toBe("none");

    const validFile = join(dir, "valid-provider.json");
    writeFileSync(validFile, JSON.stringify({ embeddingProvider: "hash" }));
    expect(loadConfig({ env: {}, configPath: validFile }).embeddingProvider).toBe("hash");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
