import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mergeSnapshots } from "./merge";
import { USAGE_CSS, USAGE_JS, USAGE_PAGE } from "./page";
import type { UsageSnapshot } from "./types";

export interface UsageRequestOptions { snapshotDir: string }

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
  "x-robots-tag": "noindex, nofollow, noarchive",
};

function response(body: BodyInit, type: string, status = 200): Response {
  return new Response(body, { status, headers: { ...SECURITY_HEADERS, "content-type": type } });
}

export function readSnapshots(snapshotDir: string): UsageSnapshot[] {
  let names: string[] = [];
  try { names = readdirSync(snapshotDir).filter((name) => name.endsWith(".json")); } catch { return []; }
  const snapshots: UsageSnapshot[] = [];
  for (const name of names) {
    try {
      const value = JSON.parse(readFileSync(join(snapshotDir, name), "utf8")) as UsageSnapshot;
      if (value?.schemaVersion === 1 && Array.isArray(value.buckets) && Array.isArray(value.coverage)) snapshots.push(value);
    } catch { /* A half-written or old snapshot should not take down the page. */ }
  }
  return snapshots;
}

export async function handleUsageRequest(request: Request, options: UsageRequestOptions): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD") return response("Method Not Allowed", "text/plain; charset=utf-8", 405);
  if (url.pathname === "/" || url.pathname === "/index.html") return response(USAGE_PAGE, "text/html; charset=utf-8");
  if (url.pathname === "/assets/usage.css") return response(USAGE_CSS, "text/css; charset=utf-8");
  if (url.pathname === "/assets/usage.js") return response(USAGE_JS, "text/javascript; charset=utf-8");
  if (url.pathname === "/api/usage") return response(JSON.stringify(mergeSnapshots(readSnapshots(options.snapshotDir))), "application/json; charset=utf-8");
  if (url.pathname === "/health") return response(JSON.stringify({ ok: true }), "application/json; charset=utf-8");
  return response("Not Found", "text/plain; charset=utf-8", 404);
}

export function startUsageServer(options: UsageRequestOptions & { bindHost: string; port: number }): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: options.bindHost,
    port: options.port,
    fetch: (request) => handleUsageRequest(request, options),
  });
}

