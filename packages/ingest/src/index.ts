import { handleIngestRequest } from "./server";
import { loadConfig } from "../../../src/config";

export * from "./server";
export * from "./pipeline";
export * from "./status";

if (import.meta.main) {
  // Fat-server defaults: fold each capture into the real spine immediately and
  // serve POST /status, sharing one canonical + index with `bun run unify`.
  // INGEST_TOKEN is optional: unset/empty = no auth (local dev); set it on a
  // Tailscale-facing host to require Authorization: Bearer <token>.
  const cfg = loadConfig();
  const { ingestPort: port, canonicalDir, indexPath, ingestToken } = cfg;

  Bun.serve({
    port,
    fetch: (req) => handleIngestRequest(req, { canonicalDir, indexPath, ingestToken }),
  });

  console.log(`chat scrobbler ingest listening on http://127.0.0.1:${port}`);
  console.log(`folding captures into ${canonicalDir} + ${indexPath} (fat server; POST /status enabled)`);
  if (ingestToken) console.log("bearer token auth ENABLED on capture, asset, status, and delete endpoints");
}
