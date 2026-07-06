import { expect, test } from "bun:test";
import { DEFAULT_CONFIG, type ChatHistoryConfig } from "../src/config";
import { startServe } from "../src/cli/commands";
import { startHttpServer } from "../src/mcp/http";
import { assertTokenForExposedBind } from "../src/core/network";
import { canBindBunServer } from "./support/bun-server";

const serverTestsCanBind = canBindBunServer();

function cfgWith(overrides: Partial<ChatHistoryConfig> = {}): ChatHistoryConfig {
  return {
    ...DEFAULT_CONFIG,
    canonicalDir: "/tmp/chat-scrobbler/canonical",
    indexPath: "/tmp/chat-scrobbler/index.db",
    ingestPort: 0,
    mcpHttpPort: 0,
    bindHost: "127.0.0.1",
    ...overrides,
  };
}

test("MCP HTTP refuses a missing auth token on non-loopback bind before listening", async () => {
  await expect(startHttpServer({
    port: 0,
    bindHost: "0.0.0.0",
    indexPath: "/tmp/chat-scrobbler/index.db",
    canonicalDir: "/tmp/chat-scrobbler/canonical",
    mcpAuthToken: null,
  })).rejects.toThrow(/MCP_AUTH_TOKEN/);
});

test("ingest serve refuses a missing auth token on non-loopback bind before listening", async () => {
  await expect(startServe(cfgWith({
    bindHost: "0.0.0.0",
    ingestToken: null,
    mcpAuthToken: "mcp-token",
  }))).rejects.toThrow(/INGEST_TOKEN/);
});

test("loopback binds may omit auth tokens", () => {
  expect(() => assertTokenForExposedBind({
    bindHost: "127.0.0.1",
    token: null,
    envVarName: "INGEST_TOKEN",
    serviceName: "ingest server",
  })).not.toThrow();
  expect(() => assertTokenForExposedBind({
    bindHost: "localhost",
    token: null,
    envVarName: "MCP_AUTH_TOKEN",
    serviceName: "MCP HTTP server",
  })).not.toThrow();
});

test("non-loopback binds may use explicit auth tokens", () => {
  expect(() => assertTokenForExposedBind({
    bindHost: "0.0.0.0",
    token: "secret",
    envVarName: "INGEST_TOKEN",
    serviceName: "ingest server",
  })).not.toThrow();
});

test.skipIf(!serverTestsCanBind)("MCP HTTP starts on non-loopback when a token is configured", async () => {
  const server = await startHttpServer({
    port: 0,
    bindHost: "0.0.0.0",
    indexPath: "/tmp/chat-scrobbler/index.db",
    canonicalDir: "/tmp/chat-scrobbler/canonical",
    mcpAuthToken: "mcp-token",
  });
  server.stop(true);
});

test.skipIf(!serverTestsCanBind)("serve starts on loopback when tokens are omitted", async () => {
  const handles = await startServe(cfgWith({
    bindHost: "127.0.0.1",
    ingestToken: null,
    mcpAuthToken: null,
  }));
  handles.ingestServer.stop(true);
  handles.mcpServer.stop(true);
});
