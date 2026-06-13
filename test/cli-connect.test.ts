import { test, expect } from "bun:test";
import { DEFAULT_CONFIG, type ChatHistoryConfig } from "../src/config";
import { runConnect } from "../src/cli/commands";

function cfgWith(mcpHttpPort: number): ChatHistoryConfig {
  return { ...DEFAULT_CONFIG, mcpHttpPort };
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
  expect(out.join("\n").toLowerCase()).toContain("claude.ai");
});
