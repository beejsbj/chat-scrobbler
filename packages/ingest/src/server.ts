import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { foldCaptureIntoSpineWithEmbeddings, type SpineResult } from "./pipeline";
import { conversationStatuses } from "./status";
import {
  ASSET_INGEST_PATH,
  CAPTURE_INGEST_PATH,
  STATUS_PATH,
  HEALTH_PATH,
  toCaptureArray,
  type ProviderSource,
  type RawCapture,
} from "../../shared/src";
import { openIndex } from "../../../src/indexer/sqlite";
import { MAX_ASSET_BYTES, storeCanonicalAsset } from "../../../src/store/assets";
import type { EmbeddingProvider } from "../../../src/indexer/sqlite";

export interface IngestServerOptions {
  /**
   * Optional shared secret. When set, every POST /captures (and /status) request
   * must carry `Authorization: Bearer <token>`. Omit (or leave empty) for local
   * dev -- no auth is enforced when the option is absent or an empty string.
   * Maps 1-to-1 with the INGEST_TOKEN env var used by the production entry point.
   */
  ingestToken?: string | null;
  /**
   * "Fat server" mode. When BOTH are set, the receiver parses each capture with
   * the matching *_api parser, writes the canonical session, and indexes it
   * immediately (queryable without a separate `unify` run), and serves
   * POST /status. When omitted, the receiver only returns a count.
   */
  canonicalDir?: string;
  indexPath?: string;
  embeddingProvider?: EmbeddingProvider | null;
}

export interface IngestResponse {
  ok: true;
  count: number;
  spine: SpineResult[];
}

export interface AssetUploadResponse {
  ok: true;
  pointer: string;
  local_path: string;
  sha256: string;
  size_bytes: number;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type,authorization",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

// Cache one open Database per index file across requests -- the index is a
// shared, mutable view and re-opening an ~80MB file per capture is wasteful.
const indexCache = new Map<string, Database>();
function indexFor(indexPath: string): Database {
  let db = indexCache.get(indexPath);
  if (!db) {
    mkdirSync(dirname(indexPath), { recursive: true });
    db = openIndex(indexPath);
    indexCache.set(indexPath, db);
  }
  return db;
}

function fatMode(opts: IngestServerOptions): { canonicalDir: string; indexPath: string } | null {
  return opts.canonicalDir && opts.indexPath
    ? { canonicalDir: opts.canonicalDir, indexPath: opts.indexPath }
    : null;
}

export async function handleIngestRequest(req: Request, opts: IngestServerOptions): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "OPTIONS") return json(null, 204);

  // GET /health is always unauthenticated -- used for local health checks and
  // Tailscale load-balancer probes that cannot easily set bearer headers.
  if (req.method === "GET" && url.pathname === HEALTH_PATH) {
    return json({ ok: true, service: "chat-scrobbler-ingest" });
  }

  const isCapture = req.method === "POST" && url.pathname === CAPTURE_INGEST_PATH;
  const isAsset = req.method === "POST" && url.pathname === ASSET_INGEST_PATH;
  const isStatus = req.method === "POST" && url.pathname === STATUS_PATH;
  if (!isCapture && !isAsset && !isStatus) {
    return json({ ok: false, error: "Not found" }, 404);
  }

  // Bearer auth: only checked when a non-empty token is configured.
  if (opts.ingestToken) {
    const authHeader = req.headers.get("authorization") ?? "";
    if (authHeader !== `Bearer ${opts.ingestToken}`) {
      return json({ ok: false, error: "Unauthorized" }, 401);
    }
  }

  const fat = fatMode(opts);

  if (isAsset) {
    if (!fat) return json({ ok: false, error: "asset endpoint requires canonicalDir + indexPath" }, 400);
    try {
      const source = readSource(url.searchParams.get("source"));
      const sourceId = requiredParam(url, "source_id");
      const pointer = requiredParam(url, "pointer");
      const filename = url.searchParams.get("filename");
      const contentType = req.headers.get("content-type") ?? url.searchParams.get("content_type");
      const contentLength = req.headers.get("content-length");
      if (contentLength && Number(contentLength) > MAX_ASSET_BYTES) {
        return json({ ok: false, error: `asset exceeds ${MAX_ASSET_BYTES} byte limit` }, 413);
      }
      const bytes = new Uint8Array(await req.arrayBuffer());
      const stored = storeCanonicalAsset({
        canonicalDir: fat.canonicalDir,
        source,
        sourceId,
        pointer,
        filename,
        contentType,
        bytes,
      });
      return json({
        ok: true,
        pointer,
        ...stored,
      } satisfies AssetUploadResponse);
    } catch (error) {
      return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }

  if (isStatus) {
    if (!fat) return json({ ok: false, error: "status endpoint requires canonicalDir + indexPath" }, 400);
    try {
      const body = await req.json() as { source?: string; conversations?: Array<{ id: string; updated_at?: string | null }> };
      if (typeof body.source !== "string" || !Array.isArray(body.conversations)) {
        return json({ ok: false, error: "status requires { source, conversations[] }" }, 400);
      }
      const statuses = conversationStatuses(indexFor(fat.indexPath), body.source, body.conversations);
      return json({ ok: true, statuses });
    } catch (error) {
      return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }

  try {
    const body = await req.json();
    const captures = toCaptureArray(body);
    const spine: SpineResult[] = [];
    if (fat) {
      const db = indexFor(fat.indexPath);
      for (const capture of captures) {
        try {
          spine.push(...await foldCaptureIntoSpineWithEmbeddings(capture, {
            canonicalDir: fat.canonicalDir,
            db,
            embeddingProvider: opts.embeddingProvider ?? null,
          }));
        } catch (error) {
          logCaptureParseFailure(capture, error);
          throw error;
        }
      }
    }
    return json({ ok: true, count: captures.length, spine } satisfies IngestResponse);
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
  }
}

function requiredParam(url: URL, name: string): string;
function requiredParam(params: URLSearchParams, name: string): string;
function requiredParam(input: URL | URLSearchParams, name: string): string {
  const value = input instanceof URL ? input.searchParams.get(name) : input.get(name);
  if (!value || !value.trim()) throw new Error(`${name} is required`);
  return value;
}

function readSource(value: string | null): ProviderSource {
  if (value === "chatgpt" || value === "claude" || value === "gemini") return value;
  throw new Error("source is invalid");
}

function json(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body, null, 2), {
    status,
    headers: {
      ...corsHeaders,
      "content-type": "application/json",
    },
  });
}

function logCaptureParseFailure(capture: RawCapture, error: unknown): void {
  const line: Record<string, string> = {
    event: "capture_parse_failed",
    parser_key: `${capture.source}:${capture.capture_method}`,
    reason: error instanceof Error ? error.message : String(error),
  };
  if (capture.source_id) line.source_id = capture.source_id;
  const url = sanitizedCaptureUrl(capture);
  if (url) line.url = url;
  console.error(JSON.stringify(line));
}

function sanitizedCaptureUrl(capture: RawCapture): string | null {
  const raw = capture.raw_url ?? capture.endpoint;
  if (!raw) return null;
  try {
    const url = new URL(raw, "http://local");
    if (raw.startsWith("/")) return url.pathname;
    return `${url.origin}${url.pathname}`;
  } catch {
    const [withoutQuery] = raw.split(/[?#]/);
    return withoutQuery.trim() || null;
  }
}
