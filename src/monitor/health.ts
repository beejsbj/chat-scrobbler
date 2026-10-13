import { Database } from "bun:sqlite";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import type { IngestServerOptions } from "../../packages/ingest/src/server";
import { probeEmbedding } from "../../packages/ingest/src/health";
import { rawDirForCanonicalDir } from "../store/raw";
import { assetsDirForCanonicalDir } from "../store/assets";

function directoryHealth(path?: string) {
  if (!path) return { ok: false, reason: "store_not_configured" };
  try {
    if (!statSync(path).isDirectory()) throw new Error("not a directory");
    accessSync(path, constants.R_OK | constants.W_OK | constants.X_OK);
    return { ok: true };
  } catch { return { ok: false, reason: "store_access_failed" }; }
}

function indexHealth(path?: string) {
  if (!path || !existsSync(path)) return { ok: false, reason: "index_missing" };
  try {
    const db = new Database(path, { readonly: true });
    try { db.run("PRAGMA busy_timeout = 0"); db.query("SELECT id FROM sessions LIMIT 1").get(); }
    finally { db.close(); }
    return { ok: true };
  } catch { return { ok: false, reason: "index_read_failed" }; }
}

/** Access checks and read-only SQL do not contend with rebuild writers or create probe files. */
export async function monitorHealth(opts: IngestServerOptions) {
  const index = indexHealth(opts.indexPath);
  const canonical = directoryHealth(opts.canonicalDir);
  const raw = directoryHealth(opts.rawDir ?? (opts.canonicalDir ? rawDirForCanonicalDir(opts.canonicalDir) : undefined));
  const assets = directoryHealth(opts.canonicalDir ? assetsDirForCanonicalDir(opts.canonicalDir) : undefined);
  const semantic = await probeEmbedding(opts.embeddingProvider ?? null);
  return { ok: index.ok && canonical.ok && raw.ok && assets.ok, probe: "readonly", index, canonical, raw, assets, ...semantic };
}
