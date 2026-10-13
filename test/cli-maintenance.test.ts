import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storeRawCapture } from "../src/store/raw";
import sample from "./fixtures/chatgpt-api-sample.json";

const entry = join(import.meta.dir, "../src/cli/chat-scrobbler.ts");
test("CLI reparse dry-run prints planned sessions, then rebuilds and reports failures safely", () => {
  const root = mkdtempSync(join(tmpdir(), "cli-reparse-"));
  const canonicalDir = join(root, "canonical", "sessions");
  const indexPath = join(root, "index.db");
  const env = { ...process.env, CANONICAL_DIR: canonicalDir, INDEX_PATH: indexPath, CHAT_SCROBBLER_EMBED_PROVIDER: "none" };
  const cli = (...args: string[]) => Bun.spawnSync([process.execPath, entry, ...args], { env });
  try {
    storeRawCapture(join(root, "raw"), sample as any);
    const dry = cli("reparse", "--session", "chatgpt:conv-1", "--dry-run");
    expect(dry.exitCode).toBe(0);
    expect(dry.stdout.toString()).toContain("Would reparse 1 session");
    expect(dry.stdout.toString()).toContain("chatgpt:conv-1");
    expect(existsSync(canonicalDir)).toBe(false);
    expect(existsSync(indexPath)).toBe(false);
    expect(cli("reparse", "--source", "chatgpt").exitCode).toBe(0);
    expect(existsSync(join(canonicalDir, "chatgpt", "conv-1.json"))).toBe(true);
    storeRawCapture(join(root, "raw"), { ...sample, payload: "secret-payload" } as any);
    const failed = cli("reparse");
    expect(failed.exitCode).toBe(1);
    expect(failed.stdout.toString()).toContain("parse_failed");
    expect(failed.stdout.toString() + failed.stderr.toString()).not.toContain("secret-payload");
    expect(cli("reparse", "--source", "invalid").exitCode).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);

test("CLI unknown-types counts opaque parts per provider and type without printing JSON fragments", () => {
  const root = mkdtempSync(join(tmpdir(), "cli-unknown-"));
  const canonicalDir = join(root, "canonical", "sessions");
  const env = { ...process.env, CANONICAL_DIR: canonicalDir, INDEX_PATH: join(root, "index.db"), CHAT_SCROBBLER_EMBED_PROVIDER: "none" };
  const cli = (...args: string[]) => Bun.spawnSync([process.execPath, entry, ...args], { env });
  try {
    const capture = structuredClone(sample) as any;
    capture.payload.mapping.n3.message.content.parts.push({ content_type: "future_ui", secret: "fragment-secret" });
    capture.payload.mapping.n3.message.content.parts.push({ content_type: "future_ui", content: "different" });
    storeRawCapture(join(root, "raw"), capture);
    expect(cli("reparse").exitCode).toBe(0);
    const result = cli("unknown-types", "--json");
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout.toString());
    expect(report).toMatchObject({ scanned_sessions: 1, unreadable_sessions: 0,
      counts: [{ source: "chatgpt", provider_type: "future_ui", count: 2 }] });
    expect(result.stdout.toString()).not.toContain("fragment-secret");
    expect(JSON.parse(cli("unknown-types", "--source", "claude", "--json").stdout.toString()).counts).toEqual([]);
    expect(cli("unknown-types").stdout.toString()).toContain("chatgpt: future_ui = 2");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);
