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

export function runConnect(opts: ConnectCmdOpts): void {
  const { cfg, write } = opts;
  const binaryPath = opts.binaryPath ?? process.execPath;
  const mcpUrl = `http://127.0.0.1:${cfg.mcpHttpPort}/mcp`;

  write(`MCP endpoint (local, read-only): ${mcpUrl}`);
  write(`  Served while "chat-scrobbler serve" is running. This URL is only reachable`);
  write(`  from the same machine unless you deliberately put a secure proxy in front of it.`);
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
  write(`  Local MCP clients running on this machine may use ${mcpUrl}.`);
  write("");
  write(`Claude web/mobile:`);
  write(`  Do not paste the localhost URL into claude.ai. Cloud clients need a publicly`);
  write(`  reachable HTTPS URL plus compatible authentication. Do not publish this`);
  write(`  endpoint without auth. Cloudflare Tunnel + Access is a candidate route, but`);
  write(`  verify live Claude connector compatibility before calling it supported.`);
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

  const mcpUrl = `http://127.0.0.1:${mcpPort}/mcp`;

  process.stdout.write(`Ingest receiver (paste into extension): ${ingestUrl}\n`);
  process.stdout.write(`MCP endpoint (local, read-only):       ${mcpUrl}\n`);
  process.stdout.write(`Canonical dir: ${cfg.canonicalDir}\n`);
  process.stdout.write(`Index path:    ${cfg.indexPath}\n`);
}
