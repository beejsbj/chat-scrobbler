import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
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
  expect(cfg.bindHost).toBe("127.0.0.1");
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
      BIND_HOST: "127.0.0.2",
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
  expect(cfg.bindHost).toBe("127.0.0.2");
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
        bindHost: "127.0.0.3",
        mcpAuthToken: "from-file-token",
        mcpPublicBaseUrl: "https://from-file.example.com",
      }),
    );
    const cfg = loadConfig({
      env: {
        INDEX_PATH: "/from/env/idx.db",
        CHAT_SCROBBLER_BIND_HOST: "127.0.0.4",
        MCP_AUTH_TOKEN: "from-env-token",
      },
      configPath: file,
    });
    expect(cfg.canonicalDir).toBe("/from/file/canon"); // file wins over default
    expect(cfg.ingestPort).toBe(6000); // file wins over default
    expect(cfg.bindHost).toBe("127.0.0.4"); // env wins over file
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

test("monitor thresholds merge provider overrides and reject malformed values", () => {
  const root = mkdtempSync(join(tmpdir(), "monitor-config-"));
  const path = join(root, "config.json");
  try {
    writeFileSync(path, JSON.stringify({ monitorStaleDays: { claude: 14, gemini: null }, monitorCoverageThreshold: 0.8, monitorRecentHours: 72 }));
    const cfg = loadConfig({ configPath: path, env: { CHAT_SCROBBLER_MONITOR_STALE_DAYS_CHATGPT: "3", CHAT_SCROBBLER_MONITOR_COVERAGE_THRESHOLD: "0.9" } });
    expect(cfg.monitorStaleDays).toEqual({ chatgpt: 3, claude: 14, gemini: null });
    expect(cfg.monitorCoverageThreshold).toBe(0.9);
    expect(cfg.monitorRecentHours).toBe(72);
    writeFileSync(path, JSON.stringify({ monitorStaleDays: { claude: -1 }, monitorCoverageThreshold: 5, monitorRecentHours: "secret" }));
    const fallback = loadConfig({ configPath: path, env: {} });
    expect(fallback.monitorStaleDays).toEqual({ chatgpt: 7, claude: 7, gemini: 7 });
    expect(fallback.monitorCoverageThreshold).toBe(0.95);
    expect(fallback.monitorRecentHours).toBe(48);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bjslab compose supplies tunable provider freshness defaults", () => {
  const compose = readFileSync(join(import.meta.dir, "../docker-compose.bjslab.yml"), "utf8");
  expect(compose).toContain('${CHAT_SCROBBLER_MONITOR_STALE_DAYS_CHATGPT:-7}');
  expect(compose).toContain('${CHAT_SCROBBLER_MONITOR_STALE_DAYS_CLAUDE:-14}');
  expect(compose).toContain('${CHAT_SCROBBLER_MONITOR_STALE_DAYS_GEMINI:-21}');
});

test("EmbeddingGemma config resolves defaults, file values, and env overrides", () => {
  const defaults = loadConfig({ env: {}, configPath: null });
  expect(defaults.embeddingBaseUrl).toBe("http://127.0.0.1:4320");
  expect(loadConfig({
    env: { CHAT_SCROBBLER_EMBED_PROVIDER: "embeddinggemma" },
    configPath: null,
  }).embeddingProvider).toBe("embeddinggemma");

  const dir = mkdtempSync(join(tmpdir(), "ch-config-"));
  try {
    const file = join(dir, "embeddinggemma.json");
    writeFileSync(file, JSON.stringify({
      embeddingProvider: "embeddinggemma",
      embeddingBaseUrl: "http://file.example:4320",
      embeddingModel: "file-model",
    }));
    const fromFile = loadConfig({ env: {}, configPath: file });
    expect(fromFile.embeddingProvider).toBe("embeddinggemma");
    expect(fromFile.embeddingBaseUrl).toBe("http://file.example:4320");
    expect(fromFile.embeddingModel).toBe("file-model");

    const fromEnv = loadConfig({
      env: {
        CHAT_SCROBBLER_EMBED_PROVIDER: "hash",
        CHAT_SCROBBLER_EMBED_BASE_URL: "http://env.example:4321",
        CHAT_SCROBBLER_EMBED_MODEL: "env-model",
      },
      configPath: file,
    });
    expect(fromEnv.embeddingProvider).toBe("hash");
    expect(fromEnv.embeddingBaseUrl).toBe("http://env.example:4321");
    expect(fromEnv.embeddingModel).toBe("env-model");
    expect(loadConfig({
      env: { CHAT_SCROBBLER_EMBED_BASE_URL: "" }, configPath: file,
    }).embeddingBaseUrl).toBe("http://file.example:4320");
    expect(loadConfig({
      env: { CHAT_SCROBBLER_EMBED_BASE_URL: "" }, configPath: null,
    }).embeddingBaseUrl).toBe("http://127.0.0.1:4320");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("background backfill defaults and validated file/env controls", () => {
  const defaults=loadConfig({env:{},configPath:null});
  expect(defaults.embeddingBackfillEnabled).toBe(true);
  expect(defaults.embeddingBackfillIntervalMs).toBe(600_000);
  expect(defaults.embeddingBackfillBatchSize).toBe(25);
  const root=mkdtempSync(join(tmpdir(),"backfill-config-"));
  try {
    const file=join(root,"config.json");
    writeFileSync(file,JSON.stringify({embeddingBackfillEnabled:false,embeddingBackfillIntervalMs:2000,embeddingBackfillBatchSize:3}));
    const cfg=loadConfig({configPath:file,env:{CHAT_SCROBBLER_EMBED_BACKFILL_ENABLED:"true",CHAT_SCROBBLER_EMBED_BACKFILL_INTERVAL_MS:"4000",CHAT_SCROBBLER_EMBED_BACKFILL_BATCH_SIZE:"5"}});
    expect(cfg).toMatchObject({embeddingBackfillEnabled:true,embeddingBackfillIntervalMs:4000,embeddingBackfillBatchSize:5});
    expect(loadConfig({configPath:file,env:{CHAT_SCROBBLER_EMBED_BACKFILL_ENABLED:"false",CHAT_SCROBBLER_EMBED_BACKFILL_INTERVAL_MS:"0",CHAT_SCROBBLER_EMBED_BACKFILL_BATCH_SIZE:"1.5"}})).toMatchObject({embeddingBackfillEnabled:false,embeddingBackfillIntervalMs:2000,embeddingBackfillBatchSize:3});
    writeFileSync(file,JSON.stringify({embeddingBackfillEnabled:"yes",embeddingBackfillIntervalMs:-1,embeddingBackfillBatchSize:0}));
    expect(loadConfig({configPath:file,env:{}})).toMatchObject({embeddingBackfillEnabled:true,embeddingBackfillIntervalMs:600_000,embeddingBackfillBatchSize:25});
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('skipped embedding retry timer defaults to a day and honors file and env controls', () => {
  expect(loadConfig({env:{},configPath:null}).embeddingSkippedRetryMs).toBe(86_400_000);
  const root=mkdtempSync(join(tmpdir(),'retry-config-'));
  try {
    const path=join(root,'config.json');writeFileSync(path,JSON.stringify({embeddingSkippedRetryMs:1000}));
    expect(loadConfig({env:{},configPath:path}).embeddingSkippedRetryMs).toBe(1000);
    expect(loadConfig({env:{CHAT_SCROBBLER_EMBED_SKIPPED_RETRY_MS:'2000'},configPath:path}).embeddingSkippedRetryMs).toBe(2000);
    expect(loadConfig({env:{CHAT_SCROBBLER_EMBED_SKIPPED_RETRY_MS:'0'},configPath:path}).embeddingSkippedRetryMs).toBe(1000);
    writeFileSync(path,JSON.stringify({embeddingSkippedRetryMs:-1}));
    expect(loadConfig({env:{},configPath:path}).embeddingSkippedRetryMs).toBe(86_400_000);
  }finally{rmSync(root,{recursive:true,force:true});}
});
