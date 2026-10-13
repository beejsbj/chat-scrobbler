import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { assetsDirForCanonicalDir } from "../../../src/store/assets";
import { rawDirForCanonicalDir } from "../../../src/store/raw";
import { writeImmutableFile } from "../../../src/store/immutable-file";
import { openIndex, type EmbeddingProvider } from "../../../src/indexer/sqlite";
import { embeddingFailed, embeddingStatus, embeddingSucceeded, validateEmbedding } from "../../../src/indexer/embedding-status";
import { assetFailureCount } from "./asset-failures";
import type { IngestServerOptions } from "./server";

interface StoreHealth { writable: boolean; reason?: string; }
function writableDirectory(path: string | undefined): StoreHealth {
  if (!path) return { writable: false, reason: "store_not_configured" };
  const probe = join(path, `.health-${randomUUID()}`);
  try {
    writeImmutableFile(probe, "health check");
    rmSync(probe, { force: true });
    return { writable: true };
  } catch { return { writable: false, reason: "store_write_failed" }; }
}

function writableIndex(path: string | undefined): StoreHealth {
  if (!path) return { writable: false, reason: "index_not_configured" };
  try {
    mkdirSync(dirname(path), { recursive: true });
    const db = openIndex(path);
    try {
      db.run("CREATE TABLE IF NOT EXISTS index_health_probe (id INTEGER PRIMARY KEY, checked_at TEXT)");
      db.run("INSERT OR REPLACE INTO index_health_probe VALUES (1, ?)", [new Date().toISOString()]);
    } finally { db.close(); }
    return { writable: true };
  } catch { return { writable: false, reason: "index_write_failed" }; }
}

/** Bounded real embedding call verifies that the configured model is usable. */
async function probeEmbedding(provider: EmbeddingProvider | null) {
  if (!provider) return embeddingStatus(null);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("embedding timeout")); }, 2000);
    });
    const vector = await Promise.race([provider.embed("chat-scrobbler health check", { kind: "query", signal: controller.signal }), deadline]);
    validateEmbedding(vector);
    embeddingSucceeded(provider);
    return embeddingStatus(provider);
  } catch {
    embeddingFailed(provider, "embedding_health_failed");
    return embeddingStatus(provider);
  }
  finally { clearTimeout(timer); }
}

export async function ingestHealth(opts: IngestServerOptions) {
  const rawDir = opts.rawDir ?? (opts.canonicalDir ? rawDirForCanonicalDir(opts.canonicalDir) : undefined);
  const index = writableIndex(opts.indexPath);
  const raw = writableDirectory(rawDir);
  const assets = writableDirectory(opts.canonicalDir ? assetsDirForCanonicalDir(opts.canonicalDir) : undefined);
  const canonical = writableDirectory(opts.canonicalDir);
  const provider = opts.embeddingProvider ?? null;
  const semantic = await probeEmbedding(provider);
  const ok = index.writable && raw.writable && assets.writable && canonical.writable && semantic.semantic !== "unavailable";
  return { ok, status: ok ? "ok" : "degraded", service: "chat-scrobbler-ingest", index, raw, assets, canonical, ...semantic, asset_failures: opts.indexPath ? assetFailureCount(opts.indexPath) : 0 };
}
