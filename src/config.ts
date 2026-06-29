// src/config.ts
// Single source of truth for server-side config: paths, ports, the ingest URL,
// the ingest token, and backup targets. Resolution order (low -> high):
//
//   built-in defaults  <  config file (JSON)  <  environment variables
//
// Defaults live under ~/.local/share/chat-scrobbler so user data never sits inside
// a code checkout; env/config-file overrides still win. Browser-safe constants
// live in packages/shared/src/config.ts and are imported by the extension; this
// module layers the Node/Bun resolution (env + config file) on top of them.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_INGEST_BASE_URL } from "../packages/shared/src/config";

export interface ChatHistoryConfig {
  /** Canonical session store (source of truth). One JSON file per session. */
  canonicalDir: string;
  /** Rebuildable SQLite FTS index. */
  indexPath: string;
  /** Port the ingest server (capture receiver) listens on. */
  ingestPort: number;
  /** Port the read-only MCP HTTP connector listens on. */
  mcpHttpPort: number;
  /** Base URL the extension POSTs captures to / that `serve` prints. */
  ingestBaseUrl: string;
  /** Optional shared bearer secret for the ingest server; null = no auth. */
  ingestToken: string | null;
  /** Where `backup` writes snapshots. Every target receives every snapshot;
   *  the first entry is the primary (default for `backups` / `restore`). */
  backupTargets: string[];
  /** Semantic recall backend. "none" keeps search literal-only. */
  embeddingProvider: EmbeddingProviderKind;
  /** Provider model override. Defaults depend on the selected provider. */
  embeddingModel: string | null;
  /** Local Ollama server used when embeddingProvider = "ollama". */
  ollamaBaseUrl: string;
  /** Gemini API key used when embeddingProvider = "gemini". Prefer env. */
  geminiApiKey: string | null;
}

export type EmbeddingProviderKind = "none" | "gemini" | "ollama" | "hash";

/** Default data home: keeps user data out of whatever repo/cwd the tool runs from. */
const DATA_HOME = join(homedir(), ".local", "share", "chat-scrobbler");

export const DEFAULT_CONFIG: ChatHistoryConfig = {
  canonicalDir: join(DATA_HOME, "canonical", "sessions"),
  indexPath: join(DATA_HOME, "index", "sessions.db"),
  ingestPort: 4318,
  mcpHttpPort: 4319,
  ingestBaseUrl: DEFAULT_INGEST_BASE_URL,
  ingestToken: null,
  backupTargets: [join(DATA_HOME, "backups")],
  embeddingProvider: "none",
  embeddingModel: null,
  ollamaBaseUrl: "http://127.0.0.1:11434",
  geminiApiKey: null,
};

export interface LoadConfigOptions {
  /** Defaults to process.env. Injected for testability. */
  env?: Record<string, string | undefined>;
  /** Defaults to process.cwd(). Used to find a project-local config file. */
  cwd?: string;
  /**
   * Path to a JSON config file. `undefined` = auto-discover (CHAT_SCROBBLER_CONFIG,
   * then <cwd>/chat-scrobbler.config.json, then ~/.config/chat-scrobbler/config.json).
   * `null` = skip the file entirely. A string = use exactly that path (a missing
   * file is tolerated, not an error).
   */
  configPath?: string | null;
}

type PartialConfig = Partial<ChatHistoryConfig> & { backupTarget?: string };

const FILE_KEYS: Array<keyof ChatHistoryConfig> = [
  "canonicalDir",
  "indexPath",
  "ingestPort",
  "mcpHttpPort",
  "ingestBaseUrl",
  "ingestToken",
  "backupTargets",
  "embeddingProvider",
  "embeddingModel",
  "ollamaBaseUrl",
  "geminiApiKey",
];

/** Resolve the layered config. Pure given its options (env + fs are injectable). */
export function loadConfig(opts: LoadConfigOptions = {}): ChatHistoryConfig {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();

  const cfg: ChatHistoryConfig = { ...DEFAULT_CONFIG, backupTargets: [...DEFAULT_CONFIG.backupTargets] };

  // Layer 1: config file.
  const fileLayer = readConfigFile(resolveConfigPath(opts.configPath, env, cwd));
  for (const k of FILE_KEYS) {
    if (fileLayer[k] !== undefined) (cfg as any)[k] = fileLayer[k];
  }
  // Legacy: a singular backupTarget string in the config file still works.
  if (fileLayer.backupTargets === undefined && typeof fileLayer.backupTarget === "string" && fileLayer.backupTarget !== "") {
    cfg.backupTargets = [fileLayer.backupTarget];
  }
  // Guard against a malformed backupTargets value from the file.
  if (!Array.isArray(cfg.backupTargets) || cfg.backupTargets.length === 0 || !cfg.backupTargets.every(t => typeof t === "string" && t !== "")) {
    cfg.backupTargets = [...DEFAULT_CONFIG.backupTargets];
  }

  // Layer 2: env (highest precedence). Unknown/invalid values fall through.
  applyString(cfg, "canonicalDir", env.CANONICAL_DIR);
  applyString(cfg, "indexPath", env.INDEX_PATH);
  applyNumber(cfg, "ingestPort", env.PORT);
  applyNumber(cfg, "mcpHttpPort", env.MCP_HTTP_PORT);
  applyEmbeddingProvider(cfg, env.CHAT_SCROBBLER_EMBED_PROVIDER ?? env.EMBED_PROVIDER);
  applyNullableString(cfg, "embeddingModel", env.CHAT_SCROBBLER_EMBED_MODEL ?? env.EMBED_MODEL);
  applyString(cfg, "ollamaBaseUrl", env.CHAT_SCROBBLER_OLLAMA_BASE_URL ?? env.OLLAMA_BASE_URL);
  applyNullableString(cfg, "geminiApiKey", env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY);
  if (env.BACKUP_TARGET !== undefined && env.BACKUP_TARGET !== "") {
    const targets = env.BACKUP_TARGET.split(",").map(s => s.trim()).filter(Boolean);
    if (targets.length > 0) cfg.backupTargets = targets;
  }
  if (env.INGEST_TOKEN !== undefined) cfg.ingestToken = env.INGEST_TOKEN || null;

  // ingestBaseUrl defaults to track the resolved ingest port unless explicitly
  // overridden (so `serve` prints the right URL when the port changes), while an
  // explicit INGEST_BASE_URL / config value always wins.
  const explicitBaseUrl = env.INGEST_BASE_URL ?? fileLayer.ingestBaseUrl;
  if (explicitBaseUrl !== undefined) {
    cfg.ingestBaseUrl = explicitBaseUrl;
  } else {
    cfg.ingestBaseUrl = `http://127.0.0.1:${cfg.ingestPort}`;
  }

  return cfg;
}

/** The config file currently in effect (explicit env pointer or discovered),
 *  or null when running on pure defaults. Used by `backup` to include it. */
export function discoverConfigPath(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): string | null {
  return resolveConfigPath(undefined, env, cwd);
}

function resolveConfigPath(
  configPath: string | null | undefined,
  env: Record<string, string | undefined>,
  cwd: string,
): string | null {
  if (configPath === null) return null;
  if (typeof configPath === "string") return configPath;
  // auto-discover
  if (env.CHAT_SCROBBLER_CONFIG) return env.CHAT_SCROBBLER_CONFIG;
  const local = join(cwd, "chat-scrobbler.config.json");
  if (existsSync(local)) return local;
  const xdg = join(homedir(), ".config", "chat-scrobbler", "config.json");
  if (existsSync(xdg)) return xdg;
  return null;
}

function readConfigFile(path: string | null): PartialConfig {
  if (!path || !existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PartialConfig;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function applyString(cfg: ChatHistoryConfig, key: "canonicalDir" | "indexPath" | "ollamaBaseUrl", v: string | undefined): void {
  if (v !== undefined && v !== "") cfg[key] = v;
}

function applyNullableString(cfg: ChatHistoryConfig, key: "embeddingModel" | "geminiApiKey", v: string | undefined): void {
  if (v !== undefined) cfg[key] = v || null;
}

function applyEmbeddingProvider(cfg: ChatHistoryConfig, v: string | undefined): void {
  if (v === undefined || v === "") return;
  if (["none", "gemini", "ollama", "hash"].includes(v)) {
    cfg.embeddingProvider = v as EmbeddingProviderKind;
  }
}

function applyNumber(cfg: ChatHistoryConfig, key: "ingestPort" | "mcpHttpPort", v: string | undefined): void {
  if (v === undefined) return;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) cfg[key] = n;
}
