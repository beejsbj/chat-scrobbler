import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Database } from "bun:sqlite";
import { grepMessages, openIndex, searchMessagesReport, listSessions, type EmbeddingProvider } from "../indexer/sqlite";
import { readSession, sessionToMarkdown } from "../store/sessions";
import { loadConfig } from "../config";
import { parseSessionId } from "../core/session-id";
import { embeddingProviderFromConfig } from "../indexer/embedding-providers";
import { handleGetAsset } from "./get-asset";

export interface ServerOptions {
  indexPath: string; canonicalDir: string; embeddingProvider?: EmbeddingProvider | null;
  /** HTTP transports share the service-owned connection and its active matrix. */
  database?: Database;
}

type ToolResult = { structuredContent?: Record<string, unknown>; content: { type: "text"; text: string }[]; isError?: boolean };

const SERVER_INSTRUCTIONS = "Read-only archive of Burooj's AI chat history (ChatGPT, Claude, Gemini), captured continuously by the chat-scrobbler browser extension. Use it to recall past conversations: what was discussed, decided, or drafted in earlier chats across all providers. `search` blends full-text, semantic, and literal substring recall (set regex=true for regular expressions); `list_sessions` browses recent conversations; `get_session` fetches a full transcript by `source:source_id` id; `get_asset` returns an image or file from that transcript. Message hits carry provenance back to their exact session. The archive is append-only from this connector: nothing here can modify or delete history.";

export async function handleSearch(db: Database, args: { query: string; source?: string; limit?: number; regex?: boolean }, embeddingProvider: EmbeddingProvider | null = null): Promise<ToolResult> {
  const report = args.regex
    ? { hits: grepMessages(db, args.query, { source: args.source, limit: args.limit }), semantic: "disabled", reason: "regex_search", embedding_failures: 0 }
    : await searchMessagesReport(db, args.query, { source: args.source, limit: args.limit, embeddingProvider });
  // Clients such as Claude.ai prefer structuredContent over content when both are
  // present, so the hits must live there too or those clients see no results.
  return { content: [{ type: "text", text: JSON.stringify(report.hits, null, 2) }], structuredContent: { ...report } };
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
  const db = opts.database ?? openIndex(opts.indexPath);
  const server = new McpServer(
    { name: "chat-scrobbler", version: "0.3.0" },
    { instructions: SERVER_INSTRUCTIONS }
  );

  server.registerTool("search", {
    description: "Search across all chat messages from every source. By default this uses full-text plus configured semantic recall. Set regex=true to treat query as a regular expression and bypass FTS and semantic search. Returns message-level hits (snippet + session_id + message_id + timestamp) so you can locate where a topic was discussed. Pass a session_id to get_session for full context.",
    inputSchema: { query: z.string(), source: z.string().optional(), limit: z.number().optional(), regex: z.boolean().optional() },
  }, async (args) => handleSearch(db, args, opts.embeddingProvider ?? null));

  server.registerTool("get_session", {
    description: "Fetch a full conversation by id. The id has the form `source:source_id` (e.g. as returned by search/list_sessions). Returns canonical JSON, or rendered markdown when format='markdown'.",
    inputSchema: { id: z.string(), format: z.enum(["json", "markdown"]).optional() },
  }, async (args) => handleGetSession(opts.canonicalDir, args));

  server.registerTool("get_asset", {
    description: "Fetch an image or file attached to a conversation. Pass the session id and the asset's 64-hex sha256 (from a block's `sha256`, or the hash in a `[image -> assets/...]` path; the whole `assets/...` path also works). Images return as image content you can see; text files as text; other files (PDF, audio, documents) as an embedded resource. Only assets the session references are served; files over 5 MB return metadata only.",
    inputSchema: { session_id: z.string(), sha256: z.string() },
  }, async (args) => handleGetAsset(opts.canonicalDir, args));

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
