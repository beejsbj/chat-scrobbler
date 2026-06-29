import { test, expect } from "bun:test";
import { DEFAULT_CONFIG, type ChatHistoryConfig } from "../src/config";
import { runConnect } from "../src/cli/commands";

function cfgWith(mcpHttpPort: number): ChatHistoryConfig {
  return { ...DEFAULT_CONFIG, mcpHttpPort };
}

function publicCfg(): ChatHistoryConfig {
  return {
    ...DEFAULT_CONFIG,
    mcpHttpPort: 4319,
    mcpAuthToken: "public-test-token",
    mcpPublicBaseUrl: "https://chat-history.example.com",
  };
}

test("runConnect prints the local MCP endpoint URL from the config port", () => {
  const out: string[] = [];
  runConnect({ cfg: cfgWith(4321), binaryPath: "/usr/local/bin/chat-scrobbler", write: (s) => out.push(s) });
  expect(out.join("\n")).toContain("http://127.0.0.1:4321/mcp");
});

test("runConnect emits a Claude Desktop stdio config block pointing at the binary's mcp subcommand", () => {
  const out: string[] = [];
  runConnect({ cfg: cfgWith(4319), binaryPath: "/opt/chat-scrobbler", write: (s) => out.push(s) });
  const text = out.join("\n");
  expect(text).toContain("mcpServers");
  expect(text).toContain("/opt/chat-scrobbler");
  expect(text).toContain('"mcp"');
});

test("runConnect mentions exposing the endpoint for remote/claude.ai connectors", () => {
  const out: string[] = [];
  runConnect({ cfg: cfgWith(4319), binaryPath: "/opt/chat-scrobbler", write: (s) => out.push(s) });
  const text = out.join("\n").toLowerCase();
  expect(text).toContain("claude web/mobile");
  expect(text).toContain("publicly reachable https");
  expect(text).toContain("compatible authentication");
  expect(text).toContain("do not publish");
});

test("runConnect prints a tokenized local MCP URL when MCP auth is configured", () => {
  const out: string[] = [];
  runConnect({ cfg: publicCfg(), binaryPath: "/opt/chat-scrobbler", write: (s) => out.push(s) });
  const text = out.join("\n");
  expect(text).toContain("http://127.0.0.1:4319/mcp/public-test-token");
  expect(text).toContain("Authorization: Bearer public-test-token");
});

test("runConnect prints the Claude web connector URL from the public base URL and token", () => {
  const out: string[] = [];
  runConnect({ cfg: publicCfg(), binaryPath: "/opt/chat-scrobbler", write: (s) => out.push(s) });
  const text = out.join("\n");
  expect(text).toContain("Claude web/mobile URL:");
  expect(text).toContain("https://chat-history.example.com/mcp/public-test-token");
  expect(text).toContain("personal and ephemeral");
  expect(text).toContain("stronger OAuth/Access layer");
});

test("runConnect does not print a public Claude URL without an MCP auth token", () => {
  const out: string[] = [];
  runConnect({
    cfg: {
      ...DEFAULT_CONFIG,
      mcpPublicBaseUrl: "https://chat-history.example.com",
    },
    binaryPath: "/opt/chat-scrobbler",
    write: (s) => out.push(s),
  });
  const text = out.join("\n");
  expect(text).toContain("Set MCP_AUTH_TOKEN");
  expect(text).not.toContain("https://chat-history.example.com/mcp/");
});

test("runConnect gives OpenAI Secure MCP Tunnel guidance without claiming support", () => {
  const out: string[] = [];
  runConnect({ cfg: cfgWith(4319), binaryPath: "/opt/chat-scrobbler", write: (s) => out.push(s) });
  const text = out.join("\n");
  const lower = text.toLowerCase();
  expect(text).toContain("OpenAI Secure MCP Tunnel");
  expect(lower).toContain("verify");
  expect(lower).toContain("current tunnel requirements");
  expect(lower).toContain("compatible auth");
});
