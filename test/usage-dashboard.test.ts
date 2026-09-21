import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectClaudeUsage } from "../src/usage/adapters/claude";
import { collectCodexUsage } from "../src/usage/adapters/codex";
import { mergeSnapshots } from "../src/usage/merge";
import { projectFromPath } from "../src/usage/project";
import { handleUsageRequest } from "../src/usage/server";
import type { UsageSnapshot } from "../src/usage/types";

const roots: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

test("projectFromPath keeps durable workspace names and collapses scratch sessions", () => {
  expect(projectFromPath("/Users/burooj/BJsWorkspace/Projects/personal-site/src/pages")).toBe("personal-site");
  expect(projectFromPath("/Users/burooj/BJsWorkspace/Labs/design-lab/workbench")).toBe("design-lab");
  expect(projectFromPath("/Users/burooj/.t3/worktrees/chat-scrobbler/t3code-123")).toBe("chat-scrobbler");
  expect(projectFromPath("/Users/burooj/Documents/Codex/2026-09-21/new-chat")).toBe("Ad-hoc sessions");
  expect(projectFromPath(null)).toBe("Unattributed");
});

test("Codex adapter records cumulative token deltas by day without prompt text", async () => {
  const root = tempRoot("usage-codex-");
  const sessionDir = join(root, "sessions", "2026", "09", "20");
  mkdirSync(sessionDir, { recursive: true });
  const file = join(sessionDir, "rollout-2026-09-20T00-00-00-abc.jsonl");
  const rows = [
    { type: "session_meta", timestamp: "2026-09-20T01:00:00Z", payload: { id: "abc", cwd: "/Users/burooj/BJsWorkspace/Projects/personal-site", source: "cli", originator: "codex_cli_rs" } },
    { type: "turn_context", timestamp: "2026-09-20T01:00:01Z", payload: { model: "gpt-5.6-sol" } },
    { type: "event_msg", timestamp: "2026-09-20T01:05:00Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 } } } },
    { type: "event_msg", timestamp: "2026-09-21T01:05:00Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 180, cached_input_tokens: 70, output_tokens: 35, reasoning_output_tokens: 8, total_tokens: 215 } } } },
    { type: "response_item", timestamp: "2026-09-21T01:05:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "private prompt must not leak" }] } },
  ];
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");

  const result = await collectCodexUsage({ roots: [join(root, "sessions")], device: "mac" });
  expect(result.buckets).toEqual([
    expect.objectContaining({ date: "2026-09-20", source: "codex", project: "personal-site", sessions: 1, messages: 0, totalTokens: 120 }),
    expect.objectContaining({ date: "2026-09-21", source: "codex", project: "personal-site", sessions: 0, messages: 1, totalTokens: 95 }),
  ]);
  expect(JSON.stringify(result)).not.toContain("private prompt");
});

test("Claude adapter deduplicates streamed assistant snapshots and includes cache tokens", async () => {
  const root = tempRoot("usage-claude-");
  const dir = join(root, "projects", "demo");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "session.jsonl");
  const rows = [
    { type: "user", timestamp: "2026-09-20T10:00:00Z", cwd: "/Users/burooj/BJsWorkspace/Projects/demo", sessionId: "s1", message: { role: "user", content: "secret" } },
    { type: "assistant", timestamp: "2026-09-20T10:00:01Z", cwd: "/Users/burooj/BJsWorkspace/Projects/demo", sessionId: "s1", message: { id: "m1", model: "claude-sonnet-5", usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 10, output_tokens: 4 } } },
    { type: "assistant", timestamp: "2026-09-20T10:00:02Z", cwd: "/Users/burooj/BJsWorkspace/Projects/demo", sessionId: "s1", message: { id: "m1", model: "claude-sonnet-5", usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 10, output_tokens: 40 } } },
  ];
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");

  const result = await collectClaudeUsage({ root: join(root, "projects"), device: "mac" });
  expect(result.buckets).toEqual([
    expect.objectContaining({ source: "claude-code", project: "demo", sessions: 1, messages: 1, inputTokens: 112, cachedInputTokens: 10, cacheWriteTokens: 100, outputTokens: 40, totalTokens: 152 }),
  ]);
  expect(JSON.stringify(result)).not.toContain("secret");
});

test("mergeSnapshots sums matching cubes and preserves coverage", () => {
  const base: UsageSnapshot = {
    schemaVersion: 1,
    generatedAt: "2026-09-21T00:00:00Z",
    devices: ["mac"],
    buckets: [{ date: "2026-09-20", source: "codex", surface: "CLI", device: "mac", project: "demo", model: "gpt", sessions: 1, messages: 2, inputTokens: 10, cachedInputTokens: 2, cacheWriteTokens: 0, outputTokens: 3, reasoningTokens: 1, totalTokens: 13 }],
    coverage: [{ source: "codex", status: "exact", detail: "tokens recorded", records: 1 }],
  };
  const merged = mergeSnapshots([base, { ...base, generatedAt: "2026-09-22T00:00:00Z", devices: ["bjslab"] }]);
  expect(merged.devices).toEqual(["bjslab", "mac"]);
  expect(merged.generatedAt).toBe("2026-09-22T00:00:00Z");
  expect(merged.buckets[0]).toMatchObject({ sessions: 2, messages: 4, totalTokens: 26 });
  expect(merged.coverage).toHaveLength(1);
});

test("usage server serves the private dashboard shell and JSON API", async () => {
  const root = tempRoot("usage-server-");
  const snapshot: UsageSnapshot = {
    schemaVersion: 1,
    generatedAt: "2026-09-21T00:00:00Z",
    devices: ["mac"],
    buckets: [],
    coverage: [],
  };
  writeFileSync(join(root, "mac.json"), JSON.stringify(snapshot));

  const page = await handleUsageRequest(new Request("http://usage.local/"), { snapshotDir: root });
  expect(page.status).toBe(200);
  expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
  expect(await page.text()).toContain("AI usage, in one place");

  const api = await handleUsageRequest(new Request("http://usage.local/api/usage"), { snapshotDir: root });
  expect(api.status).toBe(200);
  expect((await api.json() as UsageSnapshot).devices).toEqual(["mac"]);
});
