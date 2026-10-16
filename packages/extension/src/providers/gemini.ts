import { DetailFailureStreak } from "./detail-failure-streak";
import { ProviderDetailError, DeterministicCaptureError, TransientSyncError } from "./sync-errors";
import { logSyncFailure, SyncFailureTracker } from "./sync-failures";
/**
 * Gemini scrobbler provider.
 *
 * Capture strategy (as of 2026-06-06, VERIFIED against live data):
 *
 * 1. CONVERSATION ID ENUMERATION — DOM sidebar (reliable).
 *    Gemini's conversation-list RPC (MaZiqc) is also available but the sidebar
 *    anchors at `/app/{16-hex-id}` are more stable. We read IDs from
 *    `document.querySelectorAll`.
 *    Limitation: we only see conversations currently visible in the sidebar. The
 *    user must scroll to load more before a full-reconcile sync picks them up.
 *
 * 2. CONTENT CAPTURE — batchexecute RPC `hNvQHb` (VERIFIED working, 2026-06-06).
 *    CONFIRMED inner payload format: ["c_<16-hex-id>"] (the c_ prefix is required).
 *    Without the prefix the RPC returns [null,null,null,0] (empty).
 *    The source-path query param must be /app/<id> (not just /app).
 *    The parsed response payload (inner JSON array from parseBatchExecuteResponse)
 *    is stored directly in RawCapture.payload and parsed by src/parsers/gemini.ts.
 *
 *    DOM MEDIA FALLBACK: supplements API media from the current conversation page.
 *    Missing WIZ bootstrap data aborts as an environmental failure, because the
 *    API parser cannot ingest a rendered DOM text substitute.
 *
 * RISKS / FOLLOW-UPS:
 * - WIZ_global_data field names (SNlM0e/cfb2h/FdrFJe) are obfuscated and may
 *   rotate with each Gemini deploy. Monitor breakage.
 * - hNvQHb RPC ID may change with server-side deploys.
 * - The "c_" prefix on conversation IDs is required by the RPC (verified 2026-06-06).
 *   The canonical source_id is stored WITHOUT the c_ prefix (matching the URL path).
 * - conversation_updated_at is set to null on DOM enumeration path because
 *   Gemini's sidebar does not expose timestamps.
 * - Unit tests mock page/fetch — no live browser required for tests.
 */

import { buildRawCapture } from "../../../shared/src";
import { assetReferences, uploadProviderAssets, type ProviderAssetCandidate } from "./assets";
import { geminiApiAssetCandidates } from "./gemini-assets";
import { captureHash } from "./capture-hash";
import { isGeminiPageBlob } from "./gemini-page-blob";
import {
  maxIso,
  parseRetryAfterMs,
  RateLimitError,
  shouldCapture,
  type ConversationSummary,
  type FetchLike,
  type ProviderAdapter,
  type ProviderCaptureOneOptions,
  type ProviderSyncOptions,
  type ProviderSyncResult,
} from "./types";

// The per-conversation load RPC ID, observed live 2026-06-05.
// SPECULATIVE: may rotate with server-side deploys.
const CONVERSATION_RPC_ID = "hNvQHb";

// Gemini batchexecute endpoint (same-origin from content script).
const BATCHEXECUTE_PATH = "/_/BardChatUi/data/batchexecute";

/**
 * Page-context helpers injected for unit testing. In production these are
 * satisfied by the real browser DOM / window globals.
 */
export interface GeminiPageContext {
  /** Returns conversation IDs extracted from the sidebar anchors. */
  listConversationIds(): string[];
  /**
   * Returns the WIZ_global_data fields needed to build the batchexecute request.
   * Returns null if not available (e.g., page not yet initialised).
   */
  readWizData(): WizData | null;
  /** Optionally reads rendered conversation text from the current page DOM. */
  readConversationDom(id: string): string | null;
  /** Best-effort rendered asset URLs from the current page DOM. */
  readConversationAssets?(id: string): Array<{ pointer: string; url: string; filename?: string | null; contentType?: string | null; providerPageBlob?: boolean }>;
}

export interface WizData {
  /** The anti-CSRF token: window.WIZ_global_data.SNlM0e */
  at: string;
  /** Build label: window.WIZ_global_data.cfb2h */
  bl: string;
  /** Session ID: window.WIZ_global_data.FdrFJe */
  fSid: string;
}

/**
 * Extracts the three WIZ fields from the inline `window.WIZ_global_data = {...}`
 * bootstrap script text. Returns null if any required field is absent.
 *
 * The values (SNlM0e CSRF token, cfb2h build label, FdrFJe session id) are plain
 * strings with no embedded quotes, so a per-field regex is robust and avoids
 * brace-matching the ~190KB WIZ object.
 */
export function parseWizDataFromScript(scriptText: string): WizData | null {
  const at = matchWizField(scriptText, "SNlM0e");
  const bl = matchWizField(scriptText, "cfb2h");
  const fSid = matchWizField(scriptText, "FdrFJe");
  if (!at || !bl || !fSid) return null;
  return { at, bl, fSid };
}

function matchWizField(text: string, key: string): string | null {
  const match = text.match(new RegExp(`"${key}":"([^"]*)"`));
  return match ? match[1]! : null;
}

/** Live browser implementation — reads from real DOM/window. */
export function createBrowserPageContext(): GeminiPageContext {
  return {
    listConversationIds() {
      if (typeof document === "undefined") return [];
      // Gemini sidebar: anchors whose href matches /app/<16-hex-id>
      const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href^="/app/"]'));
      const ids = new Set<string>();
      for (const a of anchors) {
        const match = a.getAttribute("href")?.match(/^\/app\/([0-9a-f]{16})(?:\/|$)/i);
        if (match) ids.add(match[1]);
      }
      return [...ids];
    },
    readWizData() {
      // Content scripts run in an ISOLATED world and cannot read the page's
      // window.WIZ_global_data JS global (it lives on the page's main-world
      // window). Switching this content script to world:"MAIN" is not an option
      // because it needs chrome.runtime to message the background worker. So we
      // read the fields out of the inline `window.WIZ_global_data = {...}` script
      // text, which IS reachable via the DOM from an isolated world.
      if (typeof document === "undefined") return null;
      for (const script of Array.from(document.querySelectorAll("script"))) {
        const text = script.textContent;
        if (!text || !text.includes("WIZ_global_data")) continue;
        const wiz = parseWizDataFromScript(text);
        if (wiz) return wiz;
      }
      return null;
    },
    readConversationDom(id: string) {
      if (typeof document === "undefined") return null;
      // Fallback: capture all visible text in the main conversation container.
      // Gemini renders conversation turns inside the main scrollable area.
      // NOTE: This only works when the target conversation is already loaded.
      const conversationEl = document.querySelector(`[data-conversation-id="${id}"]`)
        ?? document.querySelector("main");
      return (conversationEl as HTMLElement | null)?.innerText ?? null;
    },
    readConversationAssets(id: string) {
      if (typeof document === "undefined") return [];
      const conversationEl = document.querySelector(`[data-conversation-id="${id}"]`)
        ?? (typeof location !== "undefined" && location.pathname === `/app/${id}` ? document.querySelector("main") : null);
      if (!conversationEl) return [];
      return [...Array.from(conversationEl.querySelectorAll<HTMLElement>("img[src]")),
        ...Array.from(conversationEl.querySelectorAll<HTMLElement>("audio[src], video[src], source[src], a[download][href]"))].flatMap((element) => {
        const url = element.getAttribute("src") ?? element.getAttribute("href");
        if (!url) return [];
        return [{ pointer: url, url, filename: element.getAttribute("download") || null, contentType: element.getAttribute("type") ?? undefined,
          providerPageBlob: ["AUDIO", "VIDEO", "SOURCE"].includes(element.tagName) && isGeminiPageBlob(url, id) }];
      });
    },
  };
}

export function createGeminiAdapter(
  fetcher: FetchLike = fetch.bind(globalThis),
  pageCtx: GeminiPageContext = createBrowserPageContext(),
): ProviderAdapter {
  return {
    source: "gemini",
    backfillAssets: (id, references, options) => {
      const liveBlobs = new Set(geminiAssetCandidates(pageCtx, id)
        .filter(asset => asset.providerPageBlob && asset.url && isGeminiPageBlob(asset.url, id)).map(asset => asset.url));
      return uploadProviderAssets(fetcher, options.uploadAsset, references.map(ref => ({
      source: "gemini", sourceId: id, pointer: ref.pointer, messageId: ref.message_id,
      url: /^(https?:|data:|blob:|\/)/.test(ref.pointer) ? ref.pointer : null,
      filename: ref.filename, contentType: ref.content_type,
      providerPageBlob: liveBlobs.has(ref.pointer),
      fetchViaBackground: /^https?:/.test(ref.pointer) && !ref.pointer.startsWith("https://gemini.google.com/"),
      })), { beforeFetch: options.beforeFetch, retryRemembered: true });
    },
    sync: (options) => syncGemini(fetcher, pageCtx, options),
    listConversations: (pages = 1) => listGemini(pageCtx, pages),
    captureOne: async (id, updatedAt, options) => { await captureGeminiOne(fetcher, pageCtx, id, updatedAt, options); },
  };
}

/**
 * Enumerates the conversations currently visible in the sidebar. Gemini's
 * sidebar exposes no timestamps, so every row carries `updatedAt: null`. The
 * DOM enumeration is not paginated, so `pages` is accepted (to match the
 * ProviderAdapter contract) but ignored.
 */
async function listGemini(pageCtx: GeminiPageContext, _pages: number): Promise<ConversationSummary[]> {
  return pageCtx.listConversationIds().map((id) => ({ id, updatedAt: null }));
}

/**
 * Captures a single conversation through batchexecute, supplementing DOM media.
 * Shared by the badge-reconciliation
 * captureOne hook and the per-id loop in syncGemini so both paths stay in sync.
 */
async function captureGeminiOne(
  fetcher: FetchLike,
  pageCtx: GeminiPageContext,
  id: string,
  updatedAt: string | null,
  options: ProviderCaptureOneOptions,
  skipUnchanged = false,
): Promise<boolean> {
  const wizData = pageCtx.readWizData();
  if (!wizData) throw new TransientSyncError("Gemini bootstrap data unavailable; reload the provider page");
  const fetchedAt = new Date().toISOString();

  // PRIMARY PATH: batchexecute hNvQHb RPC.
  if (wizData) {
    const payload = await fetchConversationRpc(fetcher, id, wizData);
    if (payload !== undefined) {
      const apiCandidates = geminiApiAssetCandidates(payload, id);
      const apiPointers = new Set(apiCandidates.map(candidate => candidate.pointer));
      const candidates = [...apiCandidates, ...geminiAssetCandidates(pageCtx, id).filter(candidate => !apiPointers.has(candidate.pointer))];
      const hash = await captureHash("gemini", id, { payload, pointers: candidates.map(c => c.pointer) });
      if (skipUnchanged && hash.unchanged) return false;
      const assets = await uploadProviderAssets(
        fetcher,
        options.uploadAsset,
        candidates,
      );
      const emitted = await options.emitCapture(buildRawCapture({
        source: "gemini",
        sourceId: id,
        // endpoint includes the RPC id so the spine parser knows which RPC
        endpoint: `${BATCHEXECUTE_PATH}?rpcids=${CONVERSATION_RPC_ID}`,
        payload,
        assets,
        assetReferences: assetReferences(candidates),
        fetchedAt,
        conversationUpdatedAt: updatedAt,
        rawUrl: `https://gemini.google.com/app/${id}`,
      }));
      if (emitted !== false) await hash.remember();
      return emitted !== false;
    }
  }

  throw new SyntaxError("Gemini conversation RPC returned no payload");
}

function geminiAssetCandidates(pageCtx: GeminiPageContext, sourceId: string): ProviderAssetCandidate[] {
  return (pageCtx.readConversationAssets?.(sourceId) ?? []).map((asset) => ({
    source: "gemini",
    sourceId,
    pointer: asset.pointer,
    url: asset.url,
    filename: asset.filename ?? null,
    contentType: asset.contentType ?? null,
    providerPageBlob: asset.providerPageBlob === true,
    fetchViaBackground: /^https?:/.test(asset.url) && !asset.url.startsWith("https://gemini.google.com/"),
  }));
}

async function syncGemini(
  fetcher: FetchLike,
  pageCtx: GeminiPageContext,
  options: ProviderSyncOptions,
): Promise<ProviderSyncResult> {
  const failures = new SyncFailureTracker((options.captureFailures ?? []).filter(f => !options.shouldIgnore?.("gemini", f.source_id)));
  const detailFailures = new DetailFailureStreak((options.detailFailureStreak ?? []).filter(f => !options.shouldIgnore?.("gemini", f.source_id)));
  let scanned = 0;
  let captured = 0;
  let skipped = 0;
  let failed = 0;
  let maxConversationUpdatedAt: string | null = null;

  const ids = pageCtx.listConversationIds();

  try {
  for (const id of ids) {
    failures.observed(id);
    scanned += 1;
    if (options.shouldIgnore?.("gemini", id)) {
      failures.succeeded(id);
      skipped += 1;
      continue;
    }

    // Gemini sidebar does not expose conversation timestamps. We cannot check
    // shouldCapture() per-item. On incremental sync (lastSync set) we skip ids
    // we have already captured (tracked via the maxConversationUpdatedAt cursor
    // using fetch time as the watermark). On full reconcile (no lastSync) we
    // capture all.
    //
    // Limitation: we use null as updatedAt, so shouldCapture always returns
    // true when lastSync is null, and also when lastSync is set (because null
    // updatedAt short-circuits shouldCapture to true). This means all sidebar
    // conversations are captured every incremental sync. The cursor advancement
    // uses the fetch timestamp so the next sync's lastSync will be recent, but
    // since we don't know per-item timestamps we cannot skip individual items.
    //
    // A future improvement: capture the list RPC (MaZiqc etc.) which likely
    // contains timestamps, replacing the DOM enumeration path.
    if (failures.isQuarantined(id, null)) { skipped++; continue; }
    if (!shouldCapture(null, options.lastSync)) {
      skipped += 1;
      continue;
    }

    // conversationUpdatedAt is null on the sidebar-enumeration path: Gemini's
    // sidebar exposes no timestamps. captureGeminiOne handles the RPC primary
    // path + DOM fallback; the cursor watermark advances using fetch time.
    const fetchedAt = new Date().toISOString();
    try {
      const didCapture = await captureGeminiOne(fetcher, pageCtx, id, null, {
        emitCapture: options.emitCapture,
        uploadAsset: options.uploadAsset,
      }, true);
      detailFailures.succeeded(id);
      failures.succeeded(id);
      if (!didCapture) { skipped++; maxConversationUpdatedAt = maxIso(maxConversationUpdatedAt, fetchedAt); continue; }
      captured += 1;
      maxConversationUpdatedAt = maxIso(maxConversationUpdatedAt, fetchedAt);
    } catch (error) {
      detailFailures.failed(error, id, null);
      failed++;
      failures.failed(id, null, error);
      if (failures.isQuarantined(id, null)) maxConversationUpdatedAt = maxIso(maxConversationUpdatedAt, fetchedAt);
      logSyncFailure("gemini", id);
    }
  }

  detailFailures.finish();
  failures.finishListing(false); // Sidebar absence cannot confirm deletion.
  return { source: "gemini", scanned, captured, skipped, failed, captureFailures: failures.list(), detailFailureStreak: detailFailures.snapshot(), maxConversationUpdatedAt: failures.pendingListed ? options.lastSync ?? null : maxConversationUpdatedAt, account: null };
  } catch (error) { return failures.abort(error); }
}

/**
 * Calls the batchexecute hNvQHb RPC to load a single conversation.
 * Returns the parsed inner payload (hNvQHb inner array — see src/parsers/gemini.ts
 * for the verified structure).
 *
 * VERIFIED 2026-06-06: the inner payload MUST use the "c_" prefixed id.
 * Without the prefix the server returns [null,null,null,0] (empty response).
 * The source-path parameter must be the full /app/<id> path.
 */
async function fetchConversationRpc(
  fetcher: FetchLike,
  conversationId: string,
  wiz: WizData,
): Promise<unknown> {
  // The inner payload for hNvQHb: ["c_<id>"] — the c_ prefix is REQUIRED.
  // Verified against live Gemini data on 2026-06-06.
  const innerPayload = JSON.stringify(["c_" + conversationId]);
  const fReq = JSON.stringify([[[CONVERSATION_RPC_ID, innerPayload, null, "generic"]]]);

  const reqid = Math.floor(Math.random() * 900000) + 100000;
  const params = new URLSearchParams({
    rpcids: CONVERSATION_RPC_ID,
    "source-path": `/app/${conversationId}`,
    bl: wiz.bl,
    "f.sid": wiz.fSid,
    hl: "en",
    _reqid: String(reqid),
    rt: "c",
  });

  const body = new URLSearchParams({ "f.req": fReq, at: wiz.at });

  let res: Response;
  try { res = await fetcher(`${BATCHEXECUTE_PATH}?${params.toString()}`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  }); } catch { throw new TransientSyncError("Provider network unavailable"); }

  if (res.status === 429 || res.status === 503) throw new RateLimitError(BATCHEXECUTE_PATH, res.status, parseRetryAfterMs(res.headers.get("retry-after")));
  if (res.status >= 500) throw new ProviderDetailError(res.status);
  if (!res.ok) throw new DeterministicCaptureError(`Provider rejected capture (${res.status})`, res.status);
  let text: string;
  try { text = await res.text(); } catch { throw new TransientSyncError("Provider response interrupted"); }
  return parseBatchExecuteResponse(text, CONVERSATION_RPC_ID);
}

/**
 * Parses a Gemini batchexecute response body.
 *
 * Format:
 *   )]}'\n
 *   <length>\n
 *   <json-chunk>\n
 *   <length>\n
 *   <json-chunk>\n
 *   ...
 *
 * Each JSON chunk is an array. We find entries where [0] === "wrb.fr" and
 * [1] === targetRpcId, then JSON.parse the payload at [2].
 *
 * This parsing is VERIFIED against the documented format (described in the
 * design spec and recon notes). The actual payload shape at [2] for hNvQHb
 * is a deeply nested Gemini array and is NOT decoded here.
 */
export function parseBatchExecuteResponse(body: string, targetRpcId: string): unknown {
  // Strip the leading )]}' security prefix and optional whitespace.
  const stripped = body.replace(/^\s*\)\]\}'\s*/, "");

  // The body is length-delimited: alternating <decimal-length>\n<json>\n chunks.
  // We skip length lines (pure digits) and blank lines, then try JSON.parse on
  // the rest.
  for (const line of stripped.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || /^\d+$/.test(trimmed)) continue; // skip length lines and blanks
    let outer: unknown;
    try {
      outer = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!Array.isArray(outer)) continue;

    // The outer array is a list of response entries. Each top-level element is a
    // ["wrb.fr", rpcId, payloadStr, ...] array. We iterate the top-level
    // elements to find the right RPC entry.
    for (const entry of outer) {
      if (!Array.isArray(entry) || entry[0] !== "wrb.fr") continue;
      if (entry[1] !== targetRpcId) continue;
      const payloadStr = entry[2];
      if (typeof payloadStr !== "string") continue;
      try {
        return JSON.parse(payloadStr);
      } catch {
        // Malformed inner payload — return raw string so the spine can see it.
        return payloadStr;
      }
    }
  }
  throw new SyntaxError(`batchexecute response contained no wrb.fr entry for ${targetRpcId}`);
}
