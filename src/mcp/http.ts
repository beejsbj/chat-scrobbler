import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { timingSafeEqual } from "node:crypto";
import { buildServer } from "./server";
import { loadConfig } from "../config";
import { embeddingProviderFromConfig } from "../indexer/embedding-providers";
import type { EmbeddingProvider } from "../indexer/sqlite";

export interface HttpServerOptions {
  port: number;
  indexPath: string;
  canonicalDir: string;
  embeddingProvider?: EmbeddingProvider | null;
  mcpAuthToken?: string | null;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, Mcp-Session-Id, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

function addCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

type McpRoute = { kind: "base"; pathToken: null } | { kind: "token"; pathToken: string };

function parseMcpRoute(pathname: string): McpRoute | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 1 && parts[0] === "mcp") {
    return { kind: "base", pathToken: null };
  }
  if (parts.length === 2 && parts[0] === "mcp") {
    try {
      return { kind: "token", pathToken: decodeURIComponent(parts[1]) };
    } catch {
      return null;
    }
  }
  return null;
}

function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function tokensEqual(a: string | null, b: string): boolean {
  if (a === null) return false;
  const aBytes = Buffer.from(a);
  const bBytes = Buffer.from(b);
  if (aBytes.length !== bBytes.length) return false;
  return timingSafeEqual(aBytes, bBytes);
}

function authorized(req: Request, route: McpRoute, token: string | null): boolean {
  if (!token) return route.kind === "base";
  return tokensEqual(route.pathToken, token) || tokensEqual(bearerToken(req), token);
}

/**
 * Start the MCP HTTP server.
 *
 * In stateless mode the SDK transport cannot be reused across requests, so
 * we build a fresh McpServer + transport per incoming HTTP request and connect
 * them on the fly. This is the pattern the SDK explicitly supports for
 * stateless deployments.
 *
 * Returns the Bun server handle so callers (including tests) can stop it.
 */
export async function startHttpServer(
  opts: HttpServerOptions
): Promise<ReturnType<typeof Bun.serve>> {
  const mcpAuthToken = opts.mcpAuthToken ?? null;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port,

    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const route = parseMcpRoute(url.pathname);

      if (!route) {
        return new Response("Not Found", { status: 404 });
      }

      // CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 200, headers: CORS_HEADERS });
      }

      if (!authorized(req, route, mcpAuthToken)) {
        return addCors(new Response("Unauthorized", {
          status: 401,
          headers: { "WWW-Authenticate": "Bearer" },
        }));
      }

      // Stateless: create a fresh transport + server per request.
      // enableJsonResponse=true avoids SSE streaming, returning plain JSON instead.
      // SSE mode in Bun returns an empty body due to streaming teardown timing;
      // JSON mode works reliably and is sufficient for stateless request/response.
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      const mcpServer = buildServer({
        indexPath: opts.indexPath,
        canonicalDir: opts.canonicalDir,
        embeddingProvider: opts.embeddingProvider ?? null,
      });

      await mcpServer.connect(transport);

      try {
        const response = await transport.handleRequest(req);
        return addCors(response);
      } finally {
        // Best-effort cleanup; ignore errors on close.
        transport.close().catch(() => undefined);
      }
    },
  });

  const authNote = mcpAuthToken ? " (auth token required)" : "";
  process.stderr.write(`MCP HTTP server listening on http://127.0.0.1:${opts.port}/mcp${authNote}\n`);

  return server;
}

if (import.meta.main) {
  const cfg = loadConfig();
  await startHttpServer({
    port: cfg.mcpHttpPort,
    indexPath: cfg.indexPath,
    canonicalDir: cfg.canonicalDir,
    embeddingProvider: embeddingProviderFromConfig(cfg),
    mcpAuthToken: cfg.mcpAuthToken,
  });
}
