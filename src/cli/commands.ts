// src/cli/commands.ts
// Command implementations for the chat-scrobbler CLI.
// All commands accept an injected cfg and a write() function for testability.
// Zero duplicated query logic: these are thin frontends over the core fns.

import { openIndex, searchMessagesWithEmbeddings, listSessions } from "../indexer/sqlite";
import { embeddingProviderFromConfig } from "../indexer/embedding-providers";
import { readSession, sessionToMarkdown, activePath } from "../store/sessions";
import type { Role, Block } from "../schema/types";
import { runUnify } from "./unify";
import { parseSessionId } from "../core/session-id";
import { startHttpServer } from "../mcp/http";
import { handleIngestRequest } from "../../packages/ingest/src/server";
import { discoverConfigPath, type ChatHistoryConfig } from "../config";
import { resolveTarget } from "../backup/target";
import { createBackup, generateSnapshotName, listBackups, restoreBackup } from "../backup/backup";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveExtensionDir } from "./paths";

type Writer = (s: string) => void;

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

export interface SearchOpts {
  query: string;
  cfg: ChatHistoryConfig;
  source?: string;
  limit?: number;
  json?: boolean;
  write: Writer;
}

export async function runSearch(opts: SearchOpts): Promise<void> {
  const db = openIndex(opts.cfg.indexPath);
  try {
    const hits = await searchMessagesWithEmbeddings(db, opts.query, {
      source: opts.source,
      limit: opts.limit,
      embeddingProvider: embeddingProviderFromConfig(opts.cfg),
    });
    if (opts.json) {
      opts.write(JSON.stringify(hits, null, 2));
      return;
    }
    for (const h of hits) {
      const title = h.title ? ` "${h.title}"` : "";
      const ts = h.created_at ? `  ${h.created_at}` : "";
      opts.write(`${h.session_id}  [${h.role}]  ${h.snippet}${title}${ts}`);
    }
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

const VALID_ROLES: readonly Role[] = ["user", "assistant", "system", "tool"];

function filterTextBlocks(blocks: Block[]): Block[] {
  return blocks.filter((b) => b.type !== "reasoning" && b.type !== "tool_call" && b.type !== "tool_result");
}

export interface GetOpts {
  id: string;
  cfg: ChatHistoryConfig;
  format?: "json" | "markdown";
  /** When set, keep only these roles along the active conversation path. */
  roles?: string[];
  /** When set, strip reasoning and tool blocks, keeping only text/artifact/attachment. */
  textOnly?: boolean;
  write: Writer;
}

export async function runGet(opts: GetOpts): Promise<void> {
  const parsed = parseSessionId(opts.id);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  let session = readSession(opts.cfg.canonicalDir, parsed.source, parsed.sourceId);

  if (opts.roles && opts.roles.length > 0) {
    const wanted = new Set<string>();
    for (const r of opts.roles) {
      if (!VALID_ROLES.includes(r as Role)) {
        throw new Error(`Unknown role "${r}". Valid roles: ${VALID_ROLES.join(", ")}`);
      }
      wanted.add(r);
    }
    // Filter the active conversation path, not the raw branch tree, so abandoned
    // forks do not leak in. Drop active_leaf_id so the rendered/serialized view
    // is exactly the filtered turns.
    const messages = activePath(session).filter((m) => wanted.has(m.role));
    session = { ...session, messages, active_leaf_id: null };
  }

  if (opts.textOnly) {
    // Strip reasoning and tool blocks, keeping only text/artifact/attachment.
    // Apply after role filtering so order is deterministic.
    session = {
      ...session,
      messages: session.messages.map((m) => ({
        ...m,
        blocks: filterTextBlocks(m.blocks),
      })),
    };
  }

  if (opts.format === "markdown") {
    opts.write(sessionToMarkdown(session));
  } else {
    opts.write(JSON.stringify(session, null, 2));
  }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export interface ListOpts {
  cfg: ChatHistoryConfig;
  source?: string;
  titleContains?: string;
  limit?: number;
  json?: boolean;
  write: Writer;
}

export async function runList(opts: ListOpts): Promise<void> {
  const db = openIndex(opts.cfg.indexPath);
  try {
    const sessions = listSessions(db, { source: opts.source, titleContains: opts.titleContains, limit: opts.limit });
    if (opts.json) {
      opts.write(JSON.stringify(sessions, null, 2));
      return;
    }
    // Align columns: id, updated_at, message_count, title
    for (const s of sessions) {
      const title = s.title ?? "(untitled)";
      opts.write(`${s.id.padEnd(36)}  ${s.updated_at}  ${String(s.message_count).padStart(5)}  ${title}`);
    }
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// unify
// ---------------------------------------------------------------------------

export interface UnifyOpts {
  cfg: ChatHistoryConfig;
  write: Writer;
}

export async function runUnifyCmd(opts: UnifyOpts): Promise<void> {
  const provider = embeddingProviderFromConfig(opts.cfg);
  const count = await runUnify({
    canonicalDir: opts.cfg.canonicalDir,
    indexPath: opts.cfg.indexPath,
    embeddingProvider: provider,
  });
  const embeddingNote = provider ? ` with ${provider.kind ?? "configured"} embeddings` : "";
  opts.write(`Reindexed ${count} sessions from canonical into index${embeddingNote}.`);
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

export interface InitCmdOpts {
  cfg: ChatHistoryConfig;
  /** Where to write the starter config file. Never overwrites an existing one. */
  configFilePath: string;
  write: Writer;
}

export async function runInit(opts: InitCmdOpts): Promise<void> {
  const { cfg, configFilePath, write } = opts;

  mkdirSync(cfg.canonicalDir, { recursive: true });
  mkdirSync(dirname(cfg.indexPath), { recursive: true });
  write(`Canonical dir: ${cfg.canonicalDir}`);
  write(`Index path:    ${cfg.indexPath}`);

  if (existsSync(configFilePath)) {
    write(`Config:        ${configFilePath} (already exists, left untouched)`);
  } else {
    const starter = {
      canonicalDir: cfg.canonicalDir,
      indexPath: cfg.indexPath,
      ingestPort: cfg.ingestPort,
      mcpHttpPort: cfg.mcpHttpPort,
      mcpPublicBaseUrl: cfg.mcpPublicBaseUrl,
      backupTargets: cfg.backupTargets,
      embeddingProvider: cfg.embeddingProvider,
      embeddingModel: cfg.embeddingModel,
      ollamaBaseUrl: cfg.ollamaBaseUrl,
    };
    mkdirSync(dirname(configFilePath), { recursive: true });
    writeFileSync(configFilePath, JSON.stringify(starter, null, 2) + "\n");
    write(`Config:        ${configFilePath} (created)`);
  }

  const extDir = resolveExtensionDir();
  write("");
  write("Next steps:");
  write(`  1. chat-scrobbler serve   (starts the capture receiver + MCP connector)`);
  if (extDir) {
    write(`  2. Load the browser extension unpacked from: ${extDir}`);
  } else {
    write(`  2. Load the browser extension (bun run build:extension, then load packages/extension/build unpacked)`);
  }
  write(`  3. Paste the printed receiver URL into the extension popup`);
  write(`  4. chat-scrobbler connect   (MCP endpoint + connector setup)`);
}

// ---------------------------------------------------------------------------
// connect -- surface the MCP endpoint and how to wire it into clients
// ---------------------------------------------------------------------------

export interface ConnectCmdOpts {
  cfg: ChatHistoryConfig;
  /** Path to invoke for the stdio MCP server. Defaults to the running binary. */
  binaryPath?: string;
  write: Writer;
}

function mcpUrl(baseUrl: string, token?: string | null): string {
  const base = baseUrl.replace(/\/+$/, "");
  const tokenSegment = token ? `/${encodeURIComponent(token)}` : "";
  return `${base}/mcp${tokenSegment}`;
}

export function runConnect(opts: ConnectCmdOpts): void {
  const { cfg, write } = opts;
  const binaryPath = opts.binaryPath ?? process.execPath;
  const localBaseUrl = `http://127.0.0.1:${cfg.mcpHttpPort}`;
  const localMcpUrl = mcpUrl(localBaseUrl);

  write(`MCP endpoint (local, read-only): ${localMcpUrl}`);
  write(`  Served while "chat-scrobbler serve" is running. The origin stays bound`);
  write(`  to 127.0.0.1 unless you deliberately put a secure HTTPS tunnel in front of it.`);
  if (cfg.mcpAuthToken) {
    write(`MCP endpoint (local, token path): ${mcpUrl(localBaseUrl, cfg.mcpAuthToken)}`);
    write(`  Anonymous /mcp is rejected. Header-capable clients may use:`);
    write(`  Authorization: Bearer ${cfg.mcpAuthToken}`);
  }
  write("");
  write(`Claude Desktop (stdio) -- add to claude_desktop_config.json:`);
  write(
    JSON.stringify(
      { mcpServers: { "chat-scrobbler": { command: binaryPath, args: ["mcp"] } } },
      null,
      2,
    ),
  );
  write("");
  write(`Claude Desktop / local tools (HTTP):`);
  if (cfg.mcpAuthToken) {
    write(`  Local MCP clients running on this machine may use the token path above,`);
    write(`  or ${localMcpUrl} with Authorization: Bearer <token>.`);
  } else {
    write(`  Local MCP clients running on this machine may use ${localMcpUrl}.`);
  }
  write("");
  write(`Claude web/mobile:`);
  if (cfg.mcpAuthToken && cfg.mcpPublicBaseUrl) {
    write(`  Claude web/mobile URL: ${mcpUrl(cfg.mcpPublicBaseUrl, cfg.mcpAuthToken)}`);
    write(`  Point the public HTTPS tunnel at ${localMcpUrl}. This is read-only,`);
    write(`  personal and ephemeral. Add a stronger OAuth/Access layer before durable`);
    write(`  or shared exposure.`);
  } else if (cfg.mcpPublicBaseUrl && !cfg.mcpAuthToken) {
    write(`  Public base URL configured, but no Claude URL was printed. Set MCP_AUTH_TOKEN`);
    write(`  first so /mcp is not anonymous through the tunnel.`);
  } else if (cfg.mcpAuthToken) {
    write(`  Set MCP_PUBLIC_BASE_URL=https://your-tunnel.example to print a pasteable`);
    write(`  Claude web/mobile URL. Cloud clients need publicly reachable HTTPS and`);
    write(`  compatible authentication; do not publish /mcp anonymously.`);
  } else {
    write(`  Do not paste the localhost URL into claude.ai. Cloud clients need a publicly`);
    write(`  reachable HTTPS URL plus compatible authentication. Do not publish this`);
    write(`  endpoint without auth. Set MCP_AUTH_TOKEN and MCP_PUBLIC_BASE_URL to print`);
    write(`  a tokenized Claude web/mobile connector URL.`);
  }
  write("");
  write(`OpenAI Secure MCP Tunnel:`);
  write(`  Use the local endpoint as the private origin only if the tunnel's current`);
  write(`  requirements match this server and compatible auth is configured. Verify`);
  write(`  current tunnel requirements before exposing chat history.`);
  write("");
  write(`Generic public remote MCP:`);
  write(`  Requires publicly reachable HTTPS and compatible authentication. Tailscale`);
  write(`  Serve is private and will not work for cloud clients; Tailscale Funnel is`);
  write(`  public and unsafe here unless the endpoint has compatible auth.`);

  const extDir = resolveExtensionDir();
  if (extDir) {
    write("");
    write(`Browser extension: load unpacked from ${extDir}`);
  }
}

// ---------------------------------------------------------------------------
// backup / backups / restore
// ---------------------------------------------------------------------------

export interface BackupCmdOpts {
  cfg: ChatHistoryConfig;
  /** Override the config-derived target (a path for the local target). */
  targetSpec?: string;
  /** Config file to include in the snapshot; defaults to the discovered one. */
  configPath?: string;
  write: Writer;
}

export async function runBackup(opts: BackupCmdOpts): Promise<void> {
  const specs = opts.targetSpec ? [opts.targetSpec] : opts.cfg.backupTargets;
  const configPath = opts.configPath ?? discoverConfigPath() ?? undefined;
  // One name for the run so every target holds the identical snapshot.
  const snapshotName = generateSnapshotName();
  const failures: string[] = [];

  for (const spec of specs) {
    try {
      const target = resolveTarget(spec);
      const { snapshot, manifest, targetLabel } = await createBackup({
        canonicalDir: opts.cfg.canonicalDir,
        target,
        configPath,
        snapshotName,
      });
      const mb = (manifest.total_bytes / (1024 * 1024)).toFixed(1);
      opts.write(`Backed up ${manifest.session_file_count} session files (${mb} MB) to ${targetLabel} as ${snapshot}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      opts.write(`FAILED target "${spec}": ${msg}`);
      failures.push(`${spec}: ${msg}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`backup failed for ${failures.length} of ${specs.length} target(s): ${failures.join("; ")}`);
  }
}

export interface BackupsCmdOpts {
  cfg: ChatHistoryConfig;
  targetSpec?: string;
  json?: boolean;
  write: Writer;
}

export async function runBackups(opts: BackupsCmdOpts): Promise<void> {
  const target = resolveTarget(opts.targetSpec ?? opts.cfg.backupTargets[0]);
  const entries = await listBackups(target);
  if (opts.json) {
    opts.write(JSON.stringify(entries, null, 2));
    return;
  }
  for (const e of entries) {
    const count = e.manifest ? `${e.manifest.session_file_count} files` : "(no manifest)";
    const at = e.manifest?.created_at ?? "";
    opts.write(`${e.snapshot}  ${at}  ${count}`);
  }
}

export interface RestoreCmdOpts {
  cfg: ChatHistoryConfig;
  snapshot: string;
  targetSpec?: string;
  force?: boolean;
  write: Writer;
}

export async function runRestore(opts: RestoreCmdOpts): Promise<void> {
  const target = resolveTarget(opts.targetSpec ?? opts.cfg.backupTargets[0]);
  const { restored_count } = await restoreBackup({
    target,
    snapshot: opts.snapshot,
    canonicalDir: opts.cfg.canonicalDir,
    force: opts.force,
  });
  opts.write(`Restored ${restored_count} session files into ${opts.cfg.canonicalDir}`);
  opts.write(`Run "chat-scrobbler unify" to rebuild the index.`);
}

// ---------------------------------------------------------------------------
// serve
// ---------------------------------------------------------------------------

export interface ServeHandles {
  ingestServer: ReturnType<typeof Bun.serve>;
  mcpServer: Awaited<ReturnType<typeof startHttpServer>>;
}

export async function startServe(cfg: ChatHistoryConfig): Promise<ServeHandles> {
  const ingestServer = Bun.serve({
    hostname: "127.0.0.1",
    port: cfg.ingestPort,
    async fetch(req: Request): Promise<Response> {
      return handleIngestRequest(req, {
        canonicalDir: cfg.canonicalDir,
        indexPath: cfg.indexPath,
        ingestToken: cfg.ingestToken ?? undefined,
        embeddingProvider: embeddingProviderFromConfig(cfg),
      });
    },
  });

  const mcpServer = await startHttpServer({
    port: cfg.mcpHttpPort,
    indexPath: cfg.indexPath,
    canonicalDir: cfg.canonicalDir,
    embeddingProvider: embeddingProviderFromConfig(cfg),
    mcpAuthToken: cfg.mcpAuthToken,
  });

  return { ingestServer, mcpServer };
}

export function printServeInfo(cfg: ChatHistoryConfig, handles: ServeHandles): void {
  const ingestPort = handles.ingestServer.port;
  const mcpPort = handles.mcpServer.port;

  // Use actual bound port if cfg URL port differs (e.g. when port 0 was used)
  const cfgUrlPort = (() => {
    try { return new URL(cfg.ingestBaseUrl).port; } catch { return ""; }
  })();
  const ingestUrl = String(ingestPort) !== cfgUrlPort
    ? `http://127.0.0.1:${ingestPort}`
    : cfg.ingestBaseUrl;

  const localMcpUrl = mcpUrl(`http://127.0.0.1:${mcpPort}`);

  process.stdout.write(`Ingest receiver (paste into extension): ${ingestUrl}\n`);
  if (cfg.mcpAuthToken) {
    process.stdout.write(`MCP endpoint (local, token path):     ${mcpUrl(`http://127.0.0.1:${mcpPort}`, cfg.mcpAuthToken)}\n`);
    process.stdout.write(`MCP endpoint (local, Bearer auth):    ${localMcpUrl}\n`);
    if (cfg.mcpPublicBaseUrl) {
      process.stdout.write(`Claude web/mobile URL:                ${mcpUrl(cfg.mcpPublicBaseUrl, cfg.mcpAuthToken)}\n`);
    }
  } else {
    process.stdout.write(`MCP endpoint (local, read-only):       ${localMcpUrl}\n`);
    if (cfg.mcpPublicBaseUrl) {
      process.stdout.write(`Claude web/mobile URL:                not printed; set MCP_AUTH_TOKEN first\n`);
    }
  }
  process.stdout.write(`Canonical dir: ${cfg.canonicalDir}\n`);
  process.stdout.write(`Index path:    ${cfg.indexPath}\n`);
}
