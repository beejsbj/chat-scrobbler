// test/mcp-http.test.ts
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { writeSession } from "../src/store/sessions";
import { openIndex, indexSession } from "../src/indexer/sqlite";
import type { Session } from "../src/schema/types";
import { startHttpServer } from "../src/mcp/http";
import { canBindBunServer } from "./support/bun-server";

// ---- fixture setup ----

const tmpCanonical = mkdtempSync(join(tmpdir(), "mcp-http-canon-"));
const tmpIndex = mkdtempSync(join(tmpdir(), "mcp-http-idx-"));
const indexPath = join(tmpIndex, "sessions.db");

const session: Session = {
  id: "claude:http-test-abc",
  source: "claude",
  source_id: "http-test-abc",
  capture_method: "export",
  title: "HTTP Transport Test Session",
  created_at: "2025-06-01T00:00:00.000Z",
  updated_at: "2025-06-01T00:00:00.000Z",
  default_model: null,
  account: null,
  raw_ref: "claude-chats:http-test-abc",
  schema_version: 1,
  messages: [
    {
      id: "m1",
      role: "user",
      created_at: null,
      parent_id: null,
      model: null,
      blocks: [{ type: "text", text: "uniquehttptoken12345" }],
      text: "uniquehttptoken12345",
    },
  ],
};

// Write fixture into canonical dir and index
writeSession(tmpCanonical, session);
const db = openIndex(indexPath);
indexSession(db, session);
db.close();

const serverTestsCanBind = canBindBunServer();
const serverTest = test.skipIf(!serverTestsCanBind);

let bunServer: Awaited<ReturnType<typeof startHttpServer>> | null = null;
let authServer: Awaited<ReturnType<typeof startHttpServer>> | null = null;
let PORT = 0;
let AUTH_PORT = 0;
const AUTH_TOKEN = "test-public-token";

if (serverTestsCanBind) {
  bunServer = await startHttpServer({
    port: 0,
    indexPath,
    canonicalDir: tmpCanonical,
  });
  PORT = requiredPort(bunServer);

  authServer = await startHttpServer({
    port: 0,
    indexPath,
    canonicalDir: tmpCanonical,
    mcpAuthToken: AUTH_TOKEN,
  });
  AUTH_PORT = requiredPort(authServer);
}

// ---- cleanup ----

afterAll(() => {
  bunServer?.stop(true);
  authServer?.stop(true);
  rmSync(tmpCanonical, { recursive: true, force: true });
  rmSync(tmpIndex, { recursive: true, force: true });
});

// ---- helper: fresh connected SDK client ----

async function makeClient(): Promise<Client> {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${PORT}/mcp`)
  );
  await client.connect(transport);
  return client;
}

async function makeTokenPathClient(): Promise<Client> {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${AUTH_PORT}/mcp/${AUTH_TOKEN}`)
  );
  await client.connect(transport);
  return client;
}

function initializePayload(id: number): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "fetch-test-client", version: "1.0.0" },
    },
  };
}

function requiredPort(server: ReturnType<typeof Bun.serve>): number {
  if (typeof server.port !== "number") throw new Error("Bun server did not expose a port");
  return server.port;
}

// ---- tests ----

serverTest("OPTIONS /mcp returns 200 with CORS headers", async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: "OPTIONS",
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("access-control-allow-origin")).toBe("*");
});

serverTest("tools/list returns exactly search, get_session, list_sessions", async () => {
  const client = await makeClient();
  try {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(["get_session", "list_sessions", "search"]);
  } finally {
    await client.close();
  }
});

serverTest("search tool returns a hit for the known token", async () => {
  const client = await makeClient();
  try {
    const result = await client.callTool({
      name: "search",
      arguments: { query: "uniquehttptoken12345" },
    });
    const text = (result.content as { type: string; text: string }[])[0].text;
    expect(text).toContain("claude:http-test-abc");
  } finally {
    await client.close();
  }
});

serverTest("list_sessions returns the fixture session", async () => {
  const client = await makeClient();
  try {
    const result = await client.callTool({
      name: "list_sessions",
      arguments: {},
    });
    const text = (result.content as { type: string; text: string }[])[0].text;
    expect(text).toContain("claude:http-test-abc");
  } finally {
    await client.close();
  }
});

serverTest("get_session returns the fixture session content", async () => {
  const client = await makeClient();
  try {
    const result = await client.callTool({
      name: "get_session",
      arguments: { id: "claude:http-test-abc" },
    });
    const text = (result.content as { type: string; text: string }[])[0].text;
    expect(text).toContain("HTTP Transport Test Session");
    expect(text).toContain("uniquehttptoken12345");
  } finally {
    await client.close();
  }
});

serverTest("authorized /mcp/<token> path connects when an MCP auth token is configured", async () => {
  const client = await makeTokenPathClient();
  try {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(["get_session", "list_sessions", "search"]);
  } finally {
    await client.close();
  }
});

serverTest("anonymous /mcp is rejected when an MCP auth token is configured", async () => {
  const res = await fetch(`http://127.0.0.1:${AUTH_PORT}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(initializePayload(1)),
  });
  expect(res.status).toBe(401);
  expect(await res.text()).toContain("Unauthorized");
});

serverTest("Authorization: Bearer token authorizes /mcp when an MCP auth token is configured", async () => {
  const res = await fetch(`http://127.0.0.1:${AUTH_PORT}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${AUTH_TOKEN}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify(initializePayload(2)),
  });
  expect(res.status).toBe(200);
  const body = await res.json() as { result?: { serverInfo?: { name?: string } } };
  expect(body.result?.serverInfo?.name).toBe("unified-sessions");
});

serverTest("OPTIONS preflight still works without auth when an MCP auth token is configured", async () => {
  const res = await fetch(`http://127.0.0.1:${AUTH_PORT}/mcp`, {
    method: "OPTIONS",
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("access-control-allow-origin")).toBe("*");
});

serverTest("startup stderr does not print the MCP auth token", async () => {
  const token = "stderr-startup-token";
  const writes: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  let server: Awaited<ReturnType<typeof startHttpServer>> | null = null;
  try {
    server = await startHttpServer({
      port: 0,
      bindHost: "0.0.0.0",
      indexPath,
      canonicalDir: tmpCanonical,
      mcpAuthToken: token,
    });
  } finally {
    process.stderr.write = originalWrite;
    server?.stop(true);
  }

  const output = writes.join("");
  expect(output).toContain("MCP HTTP server listening on http://0.0.0.0:");
  expect(output).toContain("/mcp (auth token required)");
  expect(output).not.toContain(token);
  expect(output).not.toContain(`/mcp/${token}`);
});
