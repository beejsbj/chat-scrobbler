import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleIngestRequest } from "../packages/ingest/src";
import { ingestMaxRequestBodySize } from "../packages/ingest/src/request-body-limit";
import { buildRawCapture } from "../packages/shared/src";

const MiB = 1024 * 1024;
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "capture-body-limit-"));
  roots.push(root);
  return root;
}

function serve(maxAssetBytes: number, receiver: Parameters<typeof handleIngestRequest>[1]) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: ingestMaxRequestBodySize(maxAssetBytes),
    fetch: (req) => handleIngestRequest(req, { ...receiver, maxAssetBytes }),
  });
}

test("raw captures above 16MiB are accepted when the asset limit is tiny", async () => {
  const rawDir = join(tempRoot(), "raw");
  const server = serve(1024, { rawDir });
  try {
    const capture = buildRawCapture({
      source: "chatgpt",
      sourceId: "big-capture",
      endpoint: "/backend-api/conversation/big-capture",
      payload: { blob: "x".repeat(17 * MiB) },
      fetchedAt: "2026-06-05T10:00:00.000Z",
    });
    const res = await fetch(`http://127.0.0.1:${server.port}/captures`, { method: "POST", body: JSON.stringify(capture) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, count: 1 });
    expect(readdirSync(rawDir, { recursive: true }).length).toBeGreaterThan(0);
  } finally { await server.stop(true); }
});

test("transport limit still allows larger configured asset limits", () => {
  expect(ingestMaxRequestBodySize(1024)).toBe(128 * MiB);
  expect(ingestMaxRequestBodySize(512 * MiB)).toBe(512 * MiB);
});

test("assets above the configured limit are still rejected by /assets", async () => {
  const root = tempRoot();
  const canonicalDir = join(root, "canonical", "sessions");
  mkdirSync(canonicalDir, { recursive: true });
  const server = serve(1024, { canonicalDir, indexPath: join(root, "index.db") });
  try {
    const url = `http://127.0.0.1:${server.port}/assets?source=chatgpt&source_id=c1&pointer=p1`;
    const big = await fetch(url, { method: "POST", body: new Uint8Array(2048), headers: { "content-type": "application/octet-stream" } });
    expect(big.status).toBe(413);
    const small = await fetch(url, { method: "POST", body: new Uint8Array(512), headers: { "content-type": "application/octet-stream" } });
    expect(small.status).toBe(200);
  } finally { await server.stop(true); }
});
