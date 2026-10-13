import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRawCapture } from "../packages/shared/src";
import { listRawCaptures, readRawCapture, storeRawCapture } from "../src/store/raw";
import { handleIngestRequest } from "../packages/ingest/src";
import chatgptApi from "./fixtures/chatgpt-api-sample.json";

test("raw versions preserve unknown fields, deduplicate retries, and can be read", () => {
  const root = mkdtempSync(join(tmpdir(), "raw-store-"));
  try {
    const capture = { ...buildRawCapture({ source: "chatgpt", sourceId: "a/b", endpoint: "/detail", payload: { future_widget: [1, { opaque: true }] } }), future_envelope: "kept" };
    const first = storeRawCapture(root, capture);
    expect(storeRawCapture(root, capture)).toEqual(first);
    storeRawCapture(root, { ...capture, payload: { future_widget: "new version" } });
    const versions = listRawCaptures(root, "chatgpt", "a/b");
    expect(versions).toHaveLength(2);
    expect(readRawCapture(root, first)).toEqual(capture);
    expect(listRawCaptures(root, "chatgpt", "a_b")).toEqual([]);
    expect(() => readRawCapture(root, "../../outside.json.gz")).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ingest archives the entire batch before a parser or index failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-ingest-"));
  try {
    const broken = { ...chatgptApi, payload: [null] };
    const later = { ...chatgptApi, source_id: "later", opaque: { untouched: true } };
    const opts = { canonicalDir: join(root, "canonical", "sessions"), indexPath: join(root, "index.db") };
    const res = await handleIngestRequest(new Request("http://local/captures", { method: "POST", body: JSON.stringify([broken, later]) }), opts);
    expect(res.status).toBe(400);
    for (const capture of [broken, later]) {
      const versions = listRawCaptures(join(root, "raw"), capture.source, capture.source_id);
      expect(versions).toHaveLength(1);
      expect(readRawCapture(join(root, "raw"), versions[0]) as unknown).toEqual(capture);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("raw ingest preserves JSON bytes for single captures and batch entries", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-bytes-"));
  try {
    const serialized = JSON.stringify(chatgptApi, null, 4).replace('"payload": {', '"payload": {  ');
    for (const body of [serialized, `[\n${serialized}\n]`]) {
      await handleIngestRequest(new Request("http://local/captures", { method: "POST", body }), { rawDir: root });
    }
    const refs = listRawCaptures(root, "chatgpt", "conv-1");
    expect(refs).toHaveLength(1);
    const { readFileSync } = await import("node:fs");
    expect(Buffer.from(Bun.gunzipSync(readFileSync(join(root, refs[0])))).toString()).toBe(serialized);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("raw write failures reject capture before canonical writes with a retriable response", async () => {
  const { writeFileSync, existsSync } = await import("node:fs");
  const { spyOn } = await import("bun:test");
  const root = mkdtempSync(join(tmpdir(), "raw-write-failure-"));
  const logs = spyOn(console, "error").mockImplementation(() => {});
  try {
    const rawDir = join(root, "raw");
    writeFileSync(rawDir, "blocked");
    const canonicalDir = join(root, "canonical", "sessions");
    const res = await handleIngestRequest(new Request("http://local/captures", { method: "POST", body: JSON.stringify(chatgptApi) }), { rawDir, canonicalDir, indexPath: join(root, "index.db") });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, error: "raw_store_write_failed" });
    expect(existsSync(canonicalDir)).toBe(false);
    expect(JSON.stringify(logs.mock.calls)).toContain("raw_capture_store_failed");
  } finally { logs.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

test("raw store deduplicates unchanged content across timestamps and preserves changed versions verbatim", () => {
  const { readFileSync } = require("node:fs");
  const root = mkdtempSync(join(tmpdir(), "raw-content-"));
  try {
    const first = buildRawCapture({ source: "gemini", sourceId: "repeat", endpoint: "/rpc", fetchedAt: "2026-01-01T00:00:00Z", payload: { nested: { a: 1, b: 2 } } });
    const ref = storeRawCapture(root, first);
    const polled = { ...first, fetched_at: "2026-01-02T00:00:00Z", cursor: "volatile", payload: { nested: { b: 2, a: 1 } } };
    expect(storeRawCapture(root, polled)).toBe(ref);
    expect(listRawCaptures(root, "gemini", "repeat")).toHaveLength(1);
    const changed = { ...polled, endpoint: "/new-rpc" };
    const exact = JSON.stringify(changed, null, 3);
    const next = storeRawCapture(root, changed, exact);
    expect(Buffer.from(Bun.gunzipSync(readFileSync(join(root, next)))).toString()).toBe(exact);
    expect(storeRawCapture(root, { ...changed, fetched_at: "2026-01-03T00:00:00Z" })).toBe(next);
    storeRawCapture(root, { ...changed, payload: { nested: { b: 3, a: 1 } } });
    expect(listRawCaptures(root, "gemini", "repeat")).toHaveLength(3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("oversized raw IDs and parseable timestamps are rejected as client errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "raw-bounds-"));
  try {
    for (const fields of [{ source_id: "x".repeat(300) }, { fetched_at: "Jan 1 2026 " + "(comment)".repeat(100) }]) {
      const capture = { ...chatgptApi, ...fields };
      const response = await handleIngestRequest(new Request("http://local/captures", { method: "POST", body: JSON.stringify(capture) }), { rawDir: root });
      expect(response.status).toBe(400);
    }
    expect(listRawCaptures(root, "chatgpt", "conv-1")).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("raw dedupe preserves newly uploaded asset linkage and changes to hash or local path", () => {
  const root = mkdtempSync(join(tmpdir(), "raw-assets-"));
  try {
    const capture = buildRawCapture({ source: "gemini", sourceId: "linked", endpoint: "/rpc", payload: {} });
    const before = storeRawCapture(root, capture);
    const linked = { ...capture, assets: [{ pointer: "p", local_path: "assets/a.png", sha256: "a".repeat(64) }] };
    const after = storeRawCapture(root, linked);
    expect(after).not.toBe(before);
    expect(readRawCapture(root, after).assets).toEqual(linked.assets);
    expect(storeRawCapture(root, { ...linked, fetched_at: "2027-01-01T00:00:00Z", cursor: "noise" })).toBe(after);
    const changedHash = { ...linked, assets: [{ ...linked.assets[0], sha256: "b".repeat(64) }] };
    expect(storeRawCapture(root, changedHash)).not.toBe(after);
    storeRawCapture(root, { ...changedHash, assets: [{ ...changedHash.assets[0], local_path: "assets/b.png" }] });
    expect(listRawCaptures(root, "gemini", "linked")).toHaveLength(4);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("raw latest lookup upgrades old content hashes without adding an unchanged version", () => {
  const { writeFileSync } = require("node:fs");
  const { createHash } = require("node:crypto");
  const root = mkdtempSync(join(tmpdir(), "raw-lookup-upgrade-"));
  try {
    const capture = buildRawCapture({ source: "gemini", sourceId: "legacy", endpoint: "/rpc", payload: {}, assets: [{ pointer: "p", local_path: "assets/a.png", sha256: "a".repeat(64) }] });
    const ref = storeRawCapture(root, capture);
    writeFileSync(join(root, "gemini", "legacy", "latest.json"), JSON.stringify({ file: ref.split("/").pop(), content_hash: createHash("sha256").update(JSON.stringify({ endpoint: capture.endpoint, payload: capture.payload })).digest("hex") }));
    expect(storeRawCapture(root, { ...capture, fetched_at: "2027-01-01T00:00:00Z" })).toBe(ref);
    expect(listRawCaptures(root, "gemini", "legacy")).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unknown blocks from ingest point into the actual archived raw version", async () => {
  const { readSession } = await import("../src/store/sessions");
  const root = mkdtempSync(join(tmpdir(), "raw-unknown-"));
  try {
    const capture = structuredClone(chatgptApi) as any;
    capture.payload.mapping.n3.message.content = { content_type: "future_ui", data: "x".repeat(20000) };
    const canonicalDir = join(root, "canonical", "sessions");
    const res = await handleIngestRequest(new Request("http://local/captures", { method: "POST", body: JSON.stringify(capture) }), { canonicalDir, indexPath: join(root, "index.db") });
    expect(res.status).toBe(200);
    const session = readSession(canonicalDir, "chatgpt", "conv-1");
    const block = session.messages[2].blocks[0];
    expect(block).toMatchObject({ type: "unknown", truncated: true, raw_ref: session.raw_ref });
    if (block.type !== "unknown") throw new Error("expected unknown");
    const raw: any = readRawCapture(join(root, "raw"), block.raw_ref);
    const fragment = block.raw_path.split("/").slice(1).reduce((value: any, key: string) => value[key.replace(/~1/g, "/").replace(/~0/g, "~")], raw);
    expect(fragment).toEqual(capture.payload.mapping.n3.message.content);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
