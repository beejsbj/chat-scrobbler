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
