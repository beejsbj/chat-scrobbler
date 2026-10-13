import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { assetsDirForCanonicalDir } from "../../../src/store/assets";
import { rawDirForCanonicalDir } from "../../../src/store/raw";
import { writeImmutableFile } from "../../../src/store/immutable-file";
import { type EmbeddingProvider } from "../../../src/indexer/sqlite";
import { embeddingStatus, validateEmbedding } from "../../../src/indexer/embedding-status";
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
    const db = new Database(path);
    try {
      db.run("PRAGMA busy_timeout = 5000");
      db.run("PRAGMA journal_mode = WAL");
      db.run("BEGIN IMMEDIATE");
      const { application_id } = db.query("PRAGMA application_id").get() as { application_id: number };
      // Dirty a main-database header page, then roll back without schema changes.
      db.run(`PRAGMA application_id = ${application_id}`);
      db.run("ROLLBACK");
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
    return { semantic: "available" as const, embedding_failures: embeddingStatus(provider, "ingest").embedding_failures };
  } catch {
    return { semantic: "unavailable" as const, reason: "embedding_health_failed", embedding_failures: embeddingStatus(provider, "ingest").embedding_failures };
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
  const ok = index.writable && raw.writable && assets.writable && canonical.writable;
  return { ok, status: ok && semantic.semantic !== "unavailable" ? "ok" : "degraded", service: "chat-scrobbler-ingest", index, raw, assets, canonical, ...semantic, asset_failures: opts.indexPath ? assetFailureCount(opts.indexPath) : 0 };
}


type CacheEntry = { expires: number; result: Promise<Awaited<ReturnType<typeof ingestHealth>>> };
const disabledCache = new Map<string, CacheEntry>();
const providerCaches = new WeakMap<EmbeddingProvider, Map<string, CacheEntry>>();

export function cachedIngestHealth(opts: IngestServerOptions) {
  const provider = opts.embeddingProvider;
  let cache = disabledCache;
  if (provider) {
    cache = providerCaches.get(provider) ?? new Map();
    providerCaches.set(provider, cache);
  }
  const key = JSON.stringify([opts.indexPath, opts.canonicalDir, opts.rawDir]);
  const previous = cache.get(key);
  if (previous && previous.expires > Date.now()) return previous.result;
  for (const [oldKey, entry] of cache) if (entry.expires <= Date.now()) cache.delete(oldKey);
  const entry: CacheEntry = { expires: Infinity, result: ingestHealth(opts) };
  entry.result = entry.result.then(result => { entry.expires = Date.now() + 30_000; return result; }, error => { cache.delete(key); throw error; });
  cache.set(key, entry);
  return entry.result;
}
