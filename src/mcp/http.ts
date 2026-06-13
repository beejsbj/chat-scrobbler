import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildServer } from "./server";
import { loadConfig } from "../config";

export interface HttpServerOptions {
  port: number;
  indexPath: string;
  canonicalDir: string;
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
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port,

    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);

      if (url.pathname !== "/mcp") {
        return new Response("Not Found", { status: 404 });
      }

      // CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 200, headers: CORS_HEADERS });
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

  process.stderr.write(
    `MCP HTTP server listening on http://127.0.0.1:${opts.port}/mcp\n`
  );

  return server;
}

if (import.meta.main) {
  const cfg = loadConfig();
  await startHttpServer({
    port: cfg.mcpHttpPort,
    indexPath: cfg.indexPath,
    canonicalDir: cfg.canonicalDir,
  });
}
