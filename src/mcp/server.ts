import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Database } from "bun:sqlite";
import { openIndex, searchMessagesWithEmbeddings, listSessions, type EmbeddingProvider } from "../indexer/sqlite";
import { readSession, sessionToMarkdown } from "../store/sessions";
import { loadConfig } from "../config";
import { parseSessionId } from "../core/session-id";
import { embeddingProviderFromConfig } from "../indexer/embedding-providers";

export interface ServerOptions { indexPath: string; canonicalDir: string; embeddingProvider?: EmbeddingProvider | null; }

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export async function handleSearch(db: Database, args: { query: string; source?: string; limit?: number }, embeddingProvider: EmbeddingProvider | null = null): Promise<ToolResult> {
  const hits = await searchMessagesWithEmbeddings(db, args.query, {
    source: args.source,
    limit: args.limit,
    embeddingProvider,
  });
  return { content: [{ type: "text", text: JSON.stringify(hits, null, 2) }] };
}

export function handleGetSession(canonicalDir: string, args: { id: string; format?: "json" | "markdown" }): ToolResult {
  const parsed = parseSessionId(args.id);
  if (!parsed.ok) {
    return { content: [{ type: "text", text: `Invalid session id "${args.id}": expected format "source:source_id"` }], isError: true };
  }
  const s = readSession(canonicalDir, parsed.source, parsed.sourceId);
  const text = args.format === "markdown" ? sessionToMarkdown(s) : JSON.stringify(s, null, 2);
  return { content: [{ type: "text", text }] };
}

export function handleListSessions(db: Database, args: { source?: string; titleContains?: string; limit?: number }): ToolResult {
  const rows = listSessions(db, args);
  return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
}

export function buildServer(opts: ServerOptions): McpServer {
  const db = openIndex(opts.indexPath);
  const server = new McpServer({ name: "unified-sessions", version: "1.0.0" });

  server.registerTool("search", {
    description: "Full-text search across all chat messages from every source. Returns message-level hits (snippet + session_id + message_id + timestamp) so you can locate where a topic was discussed. Pass a session_id to get_session for full context.",
    inputSchema: { query: z.string(), source: z.string().optional(), limit: z.number().optional() },
  }, async (args) => handleSearch(db, args, opts.embeddingProvider ?? null));

  server.registerTool("get_session", {
    description: "Fetch a full conversation by id. The id has the form `source:source_id` (e.g. as returned by search/list_sessions). Returns canonical JSON, or rendered markdown when format='markdown'.",
    inputSchema: { id: z.string(), format: z.enum(["json", "markdown"]).optional() },
  }, async (args) => handleGetSession(opts.canonicalDir, args));

  server.registerTool("list_sessions", {
    description: "Browse session summaries (id, title, source, created/updated timestamps, message_count), newest first. Optionally filter by source or a title substring.",
    inputSchema: { source: z.string().optional(), titleContains: z.string().optional(), limit: z.number().optional() },
  }, async (args) => handleListSessions(db, args));

  return server;
}

if (import.meta.main) {
  const cfg = loadConfig();
  const server = buildServer({
    indexPath: cfg.indexPath,
    canonicalDir: cfg.canonicalDir,
    embeddingProvider: embeddingProviderFromConfig(cfg),
  });
  await server.connect(new StdioServerTransport());
}
