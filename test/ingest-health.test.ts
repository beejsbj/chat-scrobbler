import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleIngestRequest } from "../packages/ingest/src";
import type { EmbeddingProvider } from "../src/indexer/sqlite";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "ingest-health-"));
  return { root, canonicalDir: join(root, "canonical", "sessions"), indexPath: join(root, "index.db") };
}

test("health verifies writable stores and explicitly disabled embeddings", async () => {
  const opts = setup();
  try {
    const response = await handleIngestRequest(new Request("http://local/health"), opts);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, status: "ok", index: { writable: true }, raw: { writable: true }, assets: { writable: true }, semantic: "disabled", embedding_failures: 0 });
  } finally { rmSync(opts.root, { recursive: true, force: true }); }
});

test("health degrades independently for a broken index, raw store, or asset store", async () => {
  for (const broken of ["index", "raw", "assets"]) {
    const opts = setup();
    try {
      if (broken === "index") mkdirSync(opts.indexPath);
      else if (broken === "raw") writeFileSync(join(opts.root, "raw"), "blocked");
      else { mkdirSync(join(opts.root, "canonical")); writeFileSync(join(opts.root, "canonical", "assets"), "blocked"); }
      const response = await handleIngestRequest(new Request("http://local/health"), opts);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ ok: false, status: "degraded", [broken]: { writable: false } });
    } finally { rmSync(opts.root, { recursive: true, force: true }); }
  }
});

test("health probes the embedder, counts failures, and reports recovery without leaking errors", async () => {
  const opts = setup();
  let failing = true;
  const provider: EmbeddingProvider = { kind: "health-test", async embed() { if (failing) throw new Error("secret-token"); return [1, 0]; } };
  const logs = spyOn(console, "error").mockImplementation(() => {});
  try {
    const bad = await handleIngestRequest(new Request("http://local/health"), { ...opts, embeddingProvider: provider });
    expect(bad.status).toBe(503);
    expect(await bad.json()).toMatchObject({ semantic: "unavailable", reason: "embedding_health_failed", embedding_failures: 1 });
    expect(JSON.stringify(logs.mock.calls)).not.toContain("secret-token");
    failing = false;
    const good = await handleIngestRequest(new Request("http://local/health"), { ...opts, embeddingProvider: provider });
    expect(good.status).toBe(200);
    expect(await good.json()).toMatchObject({ semantic: "available", embedding_failures: 1 });
  } finally { logs.mockRestore(); rmSync(opts.root, { recursive: true, force: true }); }
});

test("unconfigured receiver reports its missing stores and refuses to acknowledge lost captures", async () => {
  const response = await handleIngestRequest(new Request("http://local/health"), {});
  expect(response.status).toBe(503);
  const capture = (await import("./fixtures/chatgpt-api-sample.json")).default;
  const result = await handleIngestRequest(new Request("http://local/captures", { method: "POST", body: JSON.stringify(capture) }), {});
  expect(result.status).toBe(503);
});

test("health bounds an embedder that never responds", async () => {
  const opts = setup();
  const logs = spyOn(console, "error").mockImplementation(() => {});
  let signal: AbortSignal | undefined;
  try {
    const provider: EmbeddingProvider = { async embed(_text, context) { signal = context?.signal; return new Promise<number[]>(() => {}); } };
    const response = await handleIngestRequest(new Request("http://local/health"), { ...opts, embeddingProvider: provider });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ semantic: "unavailable", reason: "embedding_health_failed" });
    expect(signal?.aborted).toBe(true);
  } finally { logs.mockRestore(); rmSync(opts.root, { recursive: true, force: true }); }
});
