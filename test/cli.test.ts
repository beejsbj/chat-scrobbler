// test/cli.test.ts
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "../src/schema/types";
import { writeSession } from "../src/store/sessions";
import { openIndex, indexSession } from "../src/indexer/sqlite";
import { DEFAULT_CONFIG, type ChatHistoryConfig } from "../src/config";

// Import command functions
import {
  printServeInfo,
  runSearch,
  runGet,
  runList,
  runUnifyCmd,
  startServe,
} from "../src/cli/commands";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

let tmpCanonical: string;
let tmpIndex: string;
let cfg: ChatHistoryConfig;

const SESSION_A: Session = {
  id: "chatgpt:abc123",
  source: "chatgpt",
  source_id: "abc123",
  capture_method: "api",
  title: "Alpha session",
  created_at: "2025-03-01T10:00:00.000Z",
  updated_at: "2025-03-02T12:00:00.000Z",
  default_model: null,
  account: null,
  raw_ref: "chatgpt:abc123",
  schema_version: 1,
  messages: [
    {
      id: "msg1", role: "user", created_at: "2025-03-01T10:00:00.000Z",
      parent_id: null, model: null,
      blocks: [{ type: "text", text: "Hello uniquetokenABC" }],
      text: "Hello uniquetokenABC",
    },
    {
      id: "msg2", role: "assistant", created_at: "2025-03-01T10:01:00.000Z",
      parent_id: "msg1", model: null,
      blocks: [
        { type: "reasoning", text: "Let me think about this deeply" },
        { type: "text", text: "Hi there uniquetokenDEF" },
        { type: "tool_call", name: "search", input: { q: "test" } },
      ],
      text: "Hi there uniquetokenDEF",
    },
  ],
};

const SESSION_B: Session = {
  id: "claude:cl-xyz",
  source: "claude",
  source_id: "cl-xyz",
  capture_method: "api",
  title: "Beta session",
  created_at: "2025-04-01T10:00:00.000Z",
  updated_at: "2025-04-02T12:00:00.000Z",
  default_model: null,
  account: null,
  raw_ref: "claude:cl-xyz",
  schema_version: 1,
  messages: [
    {
      id: "bmsg1", role: "user", created_at: "2025-04-01T10:00:00.000Z",
      parent_id: null, model: null,
      blocks: [{ type: "text", text: "What is uniquetokenXYZ?" }],
      text: "What is uniquetokenXYZ?",
    },
  ],
};

beforeAll(() => {
  tmpCanonical = mkdtempSync(join(tmpdir(), "cli-canon-"));
  tmpIndex = join(mkdtempSync(join(tmpdir(), "cli-idx-")), "sessions.db");

  writeSession(tmpCanonical, SESSION_A);
  writeSession(tmpCanonical, SESSION_B);

  const db = openIndex(tmpIndex);
  indexSession(db, SESSION_A);
  indexSession(db, SESSION_B);
  db.close();

  cfg = {
    ...DEFAULT_CONFIG,
    canonicalDir: tmpCanonical,
    indexPath: tmpIndex,
    ingestPort: 0,
    mcpHttpPort: 0,
    ingestBaseUrl: "http://127.0.0.1:0",
    ingestToken: null,
    backupTargets: [join(tmpCanonical, "..", "backup-target")],
  };
});

afterAll(() => {
  rmSync(tmpCanonical, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// search command
// ---------------------------------------------------------------------------

test("search returns human-readable hits containing session_id and snippet", async () => {
  const lines: string[] = [];
  await runSearch({ query: "uniquetokenABC", cfg, write: (s) => lines.push(s) });
  const output = lines.join("\n");
  expect(output).toContain("chatgpt:abc123");
  expect(output).toContain("uniquetoken");
});

test("search --json returns parseable JSON array", async () => {
  const lines: string[] = [];
  await runSearch({ query: "uniquetokenXYZ", cfg, json: true, write: (s) => lines.push(s) });
  const parsed = JSON.parse(lines.join(""));
  expect(Array.isArray(parsed)).toBe(true);
  expect(parsed[0].session_id).toBe("claude:cl-xyz");
  expect(parsed[0].snippet).toBeDefined();
  expect(parsed[0].score).toBeGreaterThan(0);
  expect(parsed[0].match_sources).toContain("literal");
});

test("search --source filters to the given source", async () => {
  const lines: string[] = [];
  // uniquetokenABC only appears in the chatgpt session
  await runSearch({ query: "uniquetokenABC", cfg, source: "chatgpt", write: (s) => lines.push(s) });
  const output = lines.join("\n");
  expect(output).toContain("chatgpt:abc123");
  expect(output).not.toContain("claude:cl-xyz");
});

test("search empty query returns no results without error", async () => {
  const lines: string[] = [];
  await runSearch({ query: "   ", cfg, write: (s) => lines.push(s) });
  // No error thrown; empty or no output is fine
  expect(lines.length).toBeGreaterThanOrEqual(0);
});

// ---------------------------------------------------------------------------
// get command
// ---------------------------------------------------------------------------

test("get returns JSON by default", async () => {
  const lines: string[] = [];
  await runGet({ id: "chatgpt:abc123", cfg, write: (s) => lines.push(s) });
  const parsed = JSON.parse(lines.join(""));
  expect(parsed.id).toBe("chatgpt:abc123");
  expect(parsed.title).toBe("Alpha session");
});

test("get --format markdown returns markdown", async () => {
  const lines: string[] = [];
  await runGet({ id: "chatgpt:abc123", cfg, format: "markdown", write: (s) => lines.push(s) });
  const output = lines.join("\n");
  expect(output).toContain("# Alpha session");
  expect(output).toContain("uniquetokenABC");
});

test("get --role user keeps only user turns (json)", async () => {
  const lines: string[] = [];
  await runGet({ id: "chatgpt:abc123", cfg, roles: ["user"], write: (s) => lines.push(s) });
  const parsed = JSON.parse(lines.join(""));
  // Session wrapper + metadata preserved, messages filtered to user turns.
  expect(parsed.id).toBe("chatgpt:abc123");
  expect(parsed.title).toBe("Alpha session");
  expect(parsed.messages.length).toBe(1);
  expect(parsed.messages[0].role).toBe("user");
  expect(parsed.messages[0].text).toContain("uniquetokenABC");
  // assistant turn dropped
  expect(lines.join("")).not.toContain("uniquetokenDEF");
});

test("get --role assistant keeps only assistant turns (markdown)", async () => {
  const lines: string[] = [];
  await runGet({
    id: "chatgpt:abc123", cfg, roles: ["assistant"], format: "markdown",
    write: (s) => lines.push(s),
  });
  const output = lines.join("\n");
  expect(output).toContain("## assistant");
  expect(output).toContain("uniquetokenDEF");
  expect(output).not.toContain("## user");
  expect(output).not.toContain("uniquetokenABC");
});

test("get --role user,assistant keeps both turns", async () => {
  const lines: string[] = [];
  await runGet({ id: "chatgpt:abc123", cfg, roles: ["user", "assistant"], write: (s) => lines.push(s) });
  const parsed = JSON.parse(lines.join(""));
  expect(parsed.messages.length).toBe(2);
});

test("get rejects an unknown role and throws", async () => {
  await expect(
    runGet({ id: "chatgpt:abc123", cfg, roles: ["robot"], write: () => {} })
  ).rejects.toThrow();
});

test("get --text-only strips reasoning and tool blocks (json)", async () => {
  const lines: string[] = [];
  await runGet({ id: "chatgpt:abc123", cfg, textOnly: true, write: (s) => lines.push(s) });
  const parsed = JSON.parse(lines.join(""));
  // msg1 unchanged (only text block)
  expect(parsed.messages[0].blocks.length).toBe(1);
  expect(parsed.messages[0].blocks[0].type).toBe("text");
  // msg2 should have reasoning and tool_call stripped, only text block left
  expect(parsed.messages[1].blocks.length).toBe(1);
  expect(parsed.messages[1].blocks[0].type).toBe("text");
  expect(parsed.messages[1].blocks[0].text).toBe("Hi there uniquetokenDEF");
});

test("get --text-only strips reasoning and tool blocks (markdown)", async () => {
  const lines: string[] = [];
  await runGet({
    id: "chatgpt:abc123", cfg, textOnly: true, format: "markdown",
    write: (s) => lines.push(s),
  });
  const output = lines.join("\n");
  // reasoning block text should not appear
  expect(output).not.toContain("Let me think");
  // tool call details should not appear
  expect(output).not.toContain("search");
  // text blocks should be there
  expect(output).toContain("Hello uniquetokenABC");
  expect(output).toContain("Hi there uniquetokenDEF");
});

test("get --text-only and --role compose", async () => {
  const lines: string[] = [];
  await runGet({
    id: "chatgpt:abc123", cfg, textOnly: true, roles: ["assistant"],
    write: (s) => lines.push(s),
  });
  const parsed = JSON.parse(lines.join(""));
  // Only assistant turn, with only text blocks
  expect(parsed.messages.length).toBe(1);
  expect(parsed.messages[0].role).toBe("assistant");
  expect(parsed.messages[0].blocks.length).toBe(1);
  expect(parsed.messages[0].blocks[0].type).toBe("text");
});

test("get rejects an invalid session id and throws", async () => {
  await expect(
    runGet({ id: "nocolon", cfg, write: () => {} })
  ).rejects.toThrow();
});

test("get rejects unknown source and throws", async () => {
  await expect(
    runGet({ id: "unknown:abc", cfg, write: () => {} })
  ).rejects.toThrow();
});

// ---------------------------------------------------------------------------
// list command
// ---------------------------------------------------------------------------

test("list returns human-readable lines with id and title", async () => {
  const lines: string[] = [];
  await runList({ cfg, write: (s) => lines.push(s) });
  const output = lines.join("\n");
  expect(output).toContain("chatgpt:abc123");
  expect(output).toContain("claude:cl-xyz");
});

test("list --json returns parseable JSON array", async () => {
  const lines: string[] = [];
  await runList({ cfg, json: true, write: (s) => lines.push(s) });
  const parsed = JSON.parse(lines.join(""));
  expect(Array.isArray(parsed)).toBe(true);
  expect(parsed.length).toBe(2);
  const ids = parsed.map((s: { id: string }) => s.id);
  expect(ids).toContain("chatgpt:abc123");
  expect(ids).toContain("claude:cl-xyz");
});

test("list --source claude filters to claude sessions", async () => {
  const lines: string[] = [];
  await runList({ cfg, source: "claude", write: (s) => lines.push(s) });
  const output = lines.join("\n");
  expect(output).toContain("claude:cl-xyz");
  expect(output).not.toContain("chatgpt:abc123");
});

test("list --title filters by title substring", async () => {
  const lines: string[] = [];
  await runList({ cfg, titleContains: "Alpha", write: (s) => lines.push(s) });
  const output = lines.join("\n");
  expect(output).toContain("chatgpt:abc123");
  expect(output).not.toContain("claude:cl-xyz");
});

// ---------------------------------------------------------------------------
// unify command
// ---------------------------------------------------------------------------

test("unify re-indexes from canonical and reports count", async () => {
  const lines: string[] = [];
  await runUnifyCmd({ cfg, write: (s) => lines.push(s) });
  const output = lines.join("\n");
  expect(output).toContain("2");
});

// ---------------------------------------------------------------------------
// serve command
// ---------------------------------------------------------------------------

test("serve boots ingest + MCP HTTP on ephemeral ports and responds", async () => {
  const serveCfg: ChatHistoryConfig = {
    ...cfg,
    ingestPort: 0,
    mcpHttpPort: 0,
    ingestBaseUrl: "http://127.0.0.1:0",
  };

  const { ingestServer, mcpServer } = await startServe(serveCfg);

  try {
    // Verify ingest health endpoint
    const ingestPort = ingestServer.port;
    const healthRes = await fetch(`http://127.0.0.1:${ingestPort}/health`);
    expect(healthRes.status).toBe(200);
    const healthBody = await healthRes.json() as { ok: boolean };
    expect(healthBody.ok).toBe(true);

    // Verify MCP endpoint responds to OPTIONS (CORS preflight)
    const mcpPort = mcpServer.port;
    const optRes = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, { method: "OPTIONS" });
    expect(optRes.status).toBe(200);
  } finally {
    ingestServer.stop(true);
    mcpServer.stop(true);
  }
});

test("serve output labels MCP URL local and avoids cloud-client localhost guidance", () => {
  const serveCfg: ChatHistoryConfig = {
    ...cfg,
    ingestBaseUrl: "http://127.0.0.1:4318",
  };
  const writes: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;

  try {
    printServeInfo(serveCfg, {
      ingestServer: { port: 4318 } as ReturnType<typeof Bun.serve>,
      mcpServer: { port: 4319 } as Awaited<ReturnType<typeof startServe>>["mcpServer"],
    });
  } finally {
    process.stdout.write = originalWrite;
  }

  const output = writes.join("");
  expect(output).toContain("MCP endpoint (local, read-only):");
  expect(output).toContain("http://127.0.0.1:4319/mcp");
  expect(output).not.toContain("paste into claude.ai");
});

// ---------------------------------------------------------------------------
// End-to-end spawn test
// ---------------------------------------------------------------------------

// Repo root derived from this test file; bun via process.execPath. No
// machine-specific paths and no reliance on PATH lookup inside the spawn.
const repoRoot = join(import.meta.dir, "..");

test("CLI spawn: list --json exits 0 with parseable JSON", () => {
  const result = Bun.spawnSync(
    [process.execPath, "run", "src/cli/chat-scrobbler.ts", "list", "--json"],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        CANONICAL_DIR: tmpCanonical,
        INDEX_PATH: tmpIndex,
      },
    }
  );
  expect(result.exitCode).toBe(0);
  const stdout = result.stdout.toString();
  const parsed = JSON.parse(stdout);
  expect(Array.isArray(parsed)).toBe(true);
});

test("CLI spawn: --help explains what it is, the mental model, and the recall workflow", () => {
  const result = Bun.spawnSync(
    [process.execPath, "run", "src/cli/chat-scrobbler.ts", "--help"],
    { cwd: repoRoot, env: process.env }
  );
  expect(result.exitCode).toBe(0);
  const out = result.stdout.toString();

  // What it is: names the providers it captures.
  expect(out).toContain("ChatGPT");
  expect(out).toContain("Claude");
  expect(out).toContain("Gemini");

  // Mental model: the session-id format an agent must construct.
  expect(out).toContain("<source>:<source_id>");

  // Recall workflow: search comes before get, the two-step an agent follows.
  const searchIdx = out.indexOf("search");
  const getIdx = out.indexOf("get ");
  expect(searchIdx).toBeGreaterThan(-1);
  expect(getIdx).toBeGreaterThan(searchIdx);

  // Machine-readable affordance and a pointer to deeper docs.
  expect(out).toContain("--json");
  expect(out).toContain("github.com/beejsbj/chat-scrobbler");
});

test("CLI spawn: unknown command exits 2", () => {
  const result = Bun.spawnSync(
    [process.execPath, "run", "src/cli/chat-scrobbler.ts", "notacommand"],
    {
      cwd: repoRoot,
      env: process.env,
    }
  );
  expect(result.exitCode).toBe(2);
});

test("CLI spawn: search --json exits 0", () => {
  const result = Bun.spawnSync(
    [process.execPath, "run", "src/cli/chat-scrobbler.ts", "search", "uniquetokenABC", "--json"],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        CANONICAL_DIR: tmpCanonical,
        INDEX_PATH: tmpIndex,
      },
    }
  );
  expect(result.exitCode).toBe(0);
  const parsed = JSON.parse(result.stdout.toString());
  expect(Array.isArray(parsed)).toBe(true);
  expect(parsed[0].session_id).toBe("chatgpt:abc123");
});
