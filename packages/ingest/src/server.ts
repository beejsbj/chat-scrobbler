import { syncIssueReports } from "./sync-issues";
import { recordParseOutcome } from "../../../src/monitor/parse-state";
import { monitorWrite } from "../../../src/monitor/state-fault";
import { persistEmbeddingStatus } from "../../../src/indexer/embedding-status";
import { clearAssetOutcome, clearSessionAssetOutcomes, monitorStatePath, recordCaptureReceipt, type AssetOutcomeIdentity } from "../../../src/monitor/state";
import { cachedLiveMonitorReport } from "../../../src/monitor/live-report";
import type { MonitorConfig } from "../../../src/monitor/config";
import { backfillHealth, cachedIngestHealth } from "./health";
import type { BackfillSchedulerStatus } from "../../../src/indexer/backfill-scheduler";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { foldCaptureIntoSpine, type SpineResult } from "./pipeline";
import { recordAssetFailures } from "./asset-failures";
import { captureFailureReports } from "./capture-failures";
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
import { deleteIndexedSession, openIndex } from "../../../src/indexer/sqlite";
import { MAX_ASSET_BYTES, storeCanonicalAsset } from "../../../src/store/assets";
import { AssetBlobMissingError, lookupAssetBlob, referenceExistingAsset } from "../../../src/store/asset-dedup";
import { BodyTooLargeError, readBoundedBody } from "./bounded-body";
import { handleAssetBackfill } from "./asset-backfill";
import { captureJsonEntries } from "../../../src/store/raw-json";
import { rawDirForCanonicalDir } from "../../../src/store/raw";
import { archiveCaptureWithGeminiMedia } from "./gemini-media-retention";
import { deleteSessionArchive } from "../../../src/store/delete";
import { isSessionDeleted } from "../../../src/store/tombstones";
import type { EmbeddingProvider } from "../../../src/indexer/sqlite";

export interface IngestServerOptions extends MonitorConfig {
  /**
   * Optional shared secret. When set, every mutating/status request
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
  rawDir?: string;
  /** Used by deep health checks. Captures defer vector inference to backfill. */
  embeddingProvider?: EmbeddingProvider | null;
  /** Max accepted POST /assets body; defaults to MAX_ASSET_BYTES (100MB). */
  maxAssetBytes?: number;
  /** Live background coverage progress, only exposed through authenticated deep health. */
  backfillStatus?: () => BackfillSchedulerStatus;
}

export interface IngestResponse {
  ok: true;
  count: number;
  spine: SpineResult[];
  skipped_deleted: Array<{ source: ProviderSource; source_id: string }>;
}

export interface AssetUploadResponse {
  ok: true;
  pointer: string;
  local_path: string;
  sha256: string;
  size_bytes: number;
}

export interface DeleteCaptureResponse {
  ok: true;
  source: ProviderSource;
  source_id: string;
  local_only: true;
  canonical: ReturnType<typeof deleteSessionArchive>;
  index: ReturnType<typeof deleteIndexedSession>;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type,authorization",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
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
  if (opts.indexPath && opts.embeddingProvider) persistEmbeddingStatus(opts.embeddingProvider, monitorStatePath(opts.indexPath, opts.monitorStatePath));

  if (req.method === "OPTIONS") return json(null, 204);

  // GET /health is always unauthenticated -- used for local health checks and
  // Tailscale load-balancer probes that cannot easily set bearer headers.
  if (req.method === "GET" && url.pathname === HEALTH_PATH) {
    return json({ ok: true, service: "chat-scrobbler-ingest", status: "alive" });
  }
  if (req.method === "GET" && url.pathname === `${HEALTH_PATH}/deep`) {
    if (!opts.ingestToken || req.headers.get("authorization") !== `Bearer ${opts.ingestToken}`) return json({ ok: false, error: "Unauthorized" }, 401);
    const health = await cachedIngestHealth(opts);
    return json({...health,backfill:backfillHealth(opts)}, health.ok ? 200 : 503);
  }

  if (req.method === "GET" && url.pathname === `${STATUS_PATH}/report`) {
    if (!opts.ingestToken || req.headers.get("authorization") !== `Bearer ${opts.ingestToken}`) return json({ ok: false, error: "Unauthorized" }, 401);
    try { return json(cachedLiveMonitorReport(opts)); }
    catch { return json({ ok: false, failures: ["FAILED monitor report_unavailable"] }); }
  }

  const isCapture = req.method === "POST" && url.pathname === CAPTURE_INGEST_PATH;
  const isDeleteCapture = req.method === "DELETE" && url.pathname === CAPTURE_INGEST_PATH;
  const isAsset = req.method === "POST" && url.pathname === ASSET_INGEST_PATH;
  const isAssetLookup = req.method === "GET" && url.pathname === ASSET_INGEST_PATH;
  const isAssetReference = req.method === "POST" && url.pathname === `${ASSET_INGEST_PATH}/reference`;
  const isStatus = req.method === "POST" && url.pathname === STATUS_PATH;
  const isBackfill = (req.method === "GET" || req.method === "POST") && url.pathname === `${ASSET_INGEST_PATH}/backfill`;
  if (!isBackfill && !isCapture && !isDeleteCapture && !isAsset && !isAssetLookup && !isAssetReference && !isStatus) {
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

  if (isBackfill) {
    if (!fat) return json({ ok: false, error: "asset endpoint requires canonicalDir + indexPath" }, 400);
    const rawDir = opts.rawDir ?? rawDirForCanonicalDir(fat.canonicalDir);
    return handleAssetBackfill(req, url, { canonicalDir: fat.canonicalDir, rawDir, db: indexFor(fat.indexPath), readSource }, json);
  }

  if (isDeleteCapture) {
    if (!fat) return json({ ok: false, error: "delete endpoint requires canonicalDir + indexPath" }, 400);
    try {
      const source = readSource(url.searchParams.get("source"));
      const sourceId = requiredParam(url, "source_id");
      const canonical = deleteSessionArchive(fat.canonicalDir, source, sourceId, opts.rawDir);
      const index = deleteIndexedSession(indexFor(fat.indexPath), source, sourceId);
      const statePath = monitorStatePath(fat.indexPath, opts.monitorStatePath);
      monitorWrite(statePath, () => clearSessionAssetOutcomes(statePath, source, sourceId));
      return json({
        ok: true,
        source,
        source_id: sourceId,
        local_only: true,
        canonical,
        index,
      } satisfies DeleteCaptureResponse);
    } catch (error) {
      return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }

  if (isAssetLookup || isAssetReference) {
    if (!fat) return json({ ok: false, error: "asset endpoint requires canonicalDir + indexPath" }, 400);
    try {
      const sha256 = url.searchParams.get("sha256") ?? "";
      if (!/^[a-f0-9]{64}$/.test(sha256)) return json({ ok: false, error: "sha256 must be 64 lowercase hex characters" }, 400);
      if (isAssetLookup) {
        const found = lookupAssetBlob(fat.canonicalDir, sha256);
        return json(found ? { ok: true, exists: true, sha256, size_bytes: found.size_bytes } : { ok: true, exists: false, sha256 });
      }
      const source = readSource(url.searchParams.get("source"));
      const sourceId = requiredParam(url, "source_id");
      const pointer = requiredParam(url, "pointer");
      if (isSessionDeleted(fat.canonicalDir, source, sourceId)) return json({ ok: false, error: "session was deleted" }, 410);
      const stored = referenceExistingAsset({
        canonicalDir: fat.canonicalDir,
        source,
        sourceId,
        sha256,
        filename: url.searchParams.get("filename"),
        contentType: url.searchParams.get("content_type"),
      });
      forgetAssetFailure(fat.indexPath, opts.monitorStatePath, { source, source_id: sourceId, message_id: url.searchParams.get("message_id"), pointer });
      return json({ ok: true, pointer, ...stored } satisfies AssetUploadResponse);
    } catch (error) {
      if (error instanceof AssetBlobMissingError) return json({ ok: false, error: error.message }, 404);
      return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }

  if (isAsset) {
    if (!fat) return json({ ok: false, error: "asset endpoint requires canonicalDir + indexPath" }, 400);
    try {
      const source = readSource(url.searchParams.get("source"));
      const sourceId = requiredParam(url, "source_id");
      if (isSessionDeleted(fat.canonicalDir, source, sourceId)) return json({ ok: false, error: "session was deleted" }, 410);
      const pointer = requiredParam(url, "pointer");
      const filename = url.searchParams.get("filename");
      const contentType = req.headers.get("content-type") ?? url.searchParams.get("content_type");
      const maxBytes = opts.maxAssetBytes ?? MAX_ASSET_BYTES;
      const bytes = await readBoundedBody(req, maxBytes);
      const stored = storeCanonicalAsset({
        canonicalDir: fat.canonicalDir,
        source,
        sourceId,
        pointer,
        filename,
        messageId: url.searchParams.get("message_id"),
        originalUrl: url.searchParams.get("original_url"),
        contentType,
        bytes,
        maxBytes,
      });
      forgetAssetFailure(fat.indexPath, opts.monitorStatePath, { source, source_id: sourceId, message_id: url.searchParams.get("message_id"), pointer });
      return json({
        ok: true,
        pointer,
        ...stored,
      } satisfies AssetUploadResponse);
    } catch (error) {
      if (error instanceof BodyTooLargeError) return json({ ok: false, error: error.message }, 413);
      return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }

  if (isStatus) {
    if (!fat) return json({ ok: false, error: "status endpoint requires canonicalDir + indexPath" }, 400);
    try {
      const body = await req.json() as {
        source?: string;
        install_id?: string;
        asset_failures?: unknown;
        capture_failures?: unknown;
        last_sync_error?: unknown;
        conversations?: Array<{ id: string; updated_at?: string | null }>;
      };
      if (typeof body.source !== "string" || !Array.isArray(body.conversations)) {
        return json({ ok: false, error: "status requires { source, conversations[] }" }, 400);
      }
      const source = readSource(body.source);
      const capture_failures = captureFailureReports(fat.indexPath, source, body.capture_failures, body.install_id);
      const sync_errors = syncIssueReports(fat.indexPath, source, body.last_sync_error, body.install_id);
      const count = recordAssetFailures(fat.indexPath, source, body.asset_failures, opts.monitorStatePath);
      const statuses = conversationStatuses(indexFor(fat.indexPath), source, body.conversations);
      return json({ ok: true, statuses, capture_failures, sync_errors, ...(body.asset_failures === undefined ? {} : { asset_failures: count }) });
    } catch (error) {
      return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }

  try {
    const serialized = await req.text();
    const body = JSON.parse(serialized);
    const incoming = toCaptureArray(body);
    const entries = captureJsonEntries(serialized);
    const skipped_deleted: IngestResponse["skipped_deleted"] = [];
    const accepted = incoming.flatMap((capture, i) => {
      if (opts.canonicalDir && isSessionDeleted(opts.canonicalDir, capture.source, capture.source_id)) {
        skipped_deleted.push({ source: capture.source, source_id: capture.source_id });
        return [];
      }
      return [{ capture, serialized: entries[i] }];
    });
    const rawDir = opts.rawDir ?? (opts.canonicalDir ? rawDirForCanonicalDir(opts.canonicalDir) : null);
    if (!rawDir) return json({ ok: false, error: "raw store is not configured" }, 503);
    let archived: Array<{ capture: RawCapture; rawRef: string }>;
    try { archived = accepted.map(entry => archiveCaptureWithGeminiMedia(rawDir, entry.capture, entry.serialized)); }
    catch {
      console.error(JSON.stringify({ event: "raw_capture_store_failed", reason: "raw_store_write_failed" }));
      return json({ ok: false, error: "raw_store_write_failed" }, 503);
    }
    const captures = archived.map(entry => entry.capture);
    const rawRefs = archived.map(entry => entry.rawRef);
    if (opts.indexPath && captures.length) {
      const path = monitorStatePath(opts.indexPath, opts.monitorStatePath);
      monitorWrite(path, () => {
        for (const source of new Set(captures.map(capture => capture.source))) recordCaptureReceipt(path, source);
      });
    }
    const spine: SpineResult[] = [];
    if (fat && captures.length) {
      const db = indexFor(fat.indexPath);
      for (const [i, capture] of captures.entries()) {
        let parsed = false;
        try {
          // ACK waits for raw + canonical + FTS only. There is no async DB work
          // or inference job to outlive this request or block the next capture.
          spine.push(...foldCaptureIntoSpine(capture, {
            canonicalDir: fat.canonicalDir,
            rawRef: rawRefs[i],
            onParse: success => {
              parsed = success;
              const path = monitorStatePath(fat.indexPath, opts.monitorStatePath);
              monitorWrite(path, () => recordParseOutcome(path, capture.source, capture.source_id, success));
            },
            db,
          }));
        } catch (error) {
          if (!parsed) logCaptureParseFailure(capture, error);
          throw error;
        }
      }
    }
    return json({ ok: true, count: captures.length, spine, skipped_deleted } satisfies IngestResponse);
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

/** Best effort: a stored asset must never fail because operational state could not be updated. */
function forgetAssetFailure(indexPath: string, statePathOverride: string | null | undefined, identity: AssetOutcomeIdentity): void {
  const path = monitorStatePath(indexPath, statePathOverride);
  monitorWrite(path, () => clearAssetOutcome(path, identity));
}
