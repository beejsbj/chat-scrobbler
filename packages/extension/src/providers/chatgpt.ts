import { logSyncFailure, SyncFailureTracker } from "./sync-failures";
import { buildRawCapture } from "../../../shared/src";
import { assetReferences, uploadProviderAssets } from "./assets";
import { chatgptAssetCandidates, chatgptFileDownloadEndpoint, resolveChatgptAssetUrl } from "./chatgpt-assets";
import {
  asArray,
  asObject,
  fetchJson,
  isRateLimitError,
  maxIso,
  shouldCapture,
  type ConversationSummary,
  type FetchLike,
  type ProviderAdapter,
  type ProviderCaptureOneOptions,
  type ProviderSyncOptions,
  type ProviderSyncResult,
} from "./types";

const LIST_LIMIT = 50;

export function createChatgptAdapter(fetcher: FetchLike = fetch.bind(globalThis)): ProviderAdapter {
  return {
    source: "chatgpt",
    backfillAssets: async (id, references, options) => {
      const token = await getAccessToken(fetcher);
      const headers = token ? { authorization: `Bearer ${token}` } : undefined;
      return uploadProviderAssets(fetcher, options.uploadAsset, references.map(ref => ({
        source: "chatgpt", sourceId: id, pointer: ref.pointer, messageId: ref.message_id,
        url: chatgptFileDownloadEndpoint(ref.pointer, id, ref.message_id), headers,
        filename: ref.filename, contentType: ref.content_type,
      })), { beforeFetch: options.beforeFetch, resolveUrl: candidate => resolveChatgptAssetUrl(fetcher, candidate) });
    },
    sync: (options) => syncChatgpt(fetcher, options),
    listConversations: (pages = 1) => listChatgpt(fetcher, pages),
    captureOne: (id, updatedAt, options) => captureChatgptOne(fetcher, id, updatedAt, options),
  };
}

async function listChatgpt(fetcher: FetchLike, pages: number): Promise<ConversationSummary[]> {
  const token = await getAccessToken(fetcher);
  const headers = token ? { authorization: `Bearer ${token}` } : undefined;
  const out: ConversationSummary[] = [];
  for (let page = 0; page < pages; page++) {
    const endpoint = `/backend-api/conversations?offset=${page * LIST_LIMIT}&limit=${LIST_LIMIT}&order=updated`;
    const items = readChatgptItems(asObject(await fetchJson(fetcher, endpoint, { headers })));
    if (items.length === 0) break;
    out.push(...items);
    if (items.length < LIST_LIMIT) break;
  }
  return out;
}

async function captureChatgptOne(
  fetcher: FetchLike,
  id: string,
  updatedAt: string | null,
  options: ProviderCaptureOneOptions,
): Promise<void> {
  const token = await getAccessToken(fetcher);
  const headers = token ? { authorization: `Bearer ${token}` } : undefined;
  const detailEndpoint = `/backend-api/conversation/${encodeURIComponent(id)}`;
  const payload = await fetchJson(fetcher, detailEndpoint, { headers });
  const candidates = chatgptAssetCandidates(payload, id, headers);
  const assets = await uploadProviderAssets(
    fetcher,
    options.uploadAsset,
    candidates,
    { resolveUrl: candidate => resolveChatgptAssetUrl(fetcher, candidate) },
  );
  await options.emitCapture(buildRawCapture({
    source: "chatgpt",
    sourceId: id,
    endpoint: detailEndpoint,
    payload,
    assets,
    assetReferences: assetReferences(candidates),
    conversationUpdatedAt: updatedAt,
    rawUrl: `${currentOrigin()}${detailEndpoint}`,
  }));
}

async function syncChatgpt(fetcher: FetchLike, options: ProviderSyncOptions): Promise<ProviderSyncResult> {
  const token = await getAccessToken(fetcher);
  const headers = token ? { authorization: `Bearer ${token}` } : undefined;
  let offset = 0;
  const failures = new SyncFailureTracker(options.captureFailures);
  let scanned = 0;
  let captured = 0;
  let skipped = 0;
  let failed = 0;
  let maxConversationUpdatedAt: string | null = null;

  while (true) {
    const endpoint = `/backend-api/conversations?offset=${offset}&limit=${LIST_LIMIT}&order=updated`;
    const page = asObject(await fetchJson(fetcher, endpoint, { headers }));
    const items = readChatgptItems(page);
    if (items.length === 0) break;

    // Early-break optimisation: the list is ordered newest-first. Once we have a
    // lastSync cursor and every item on this page is at or before that cursor, we
    // have passed the frontier — there is nothing new left to capture on subsequent
    // pages and we can stop paginating entirely. Only applied when lastSync is set;
    // a full-reconcile (no cursor) must walk all pages.
    if (options.lastSync && items.every((item) => !shouldCapture(item.updatedAt, options.lastSync))) {
      scanned += items.length;
      skipped += items.length;
      break;
    }

    for (const item of items) {
      scanned += 1;
      if (options.shouldIgnore?.("chatgpt", item.id)) {
        skipped += 1;
        continue;
      }
      if (failures.isQuarantined(item.id, item.updatedAt)) {
        skipped++;
        maxConversationUpdatedAt = maxIso(maxConversationUpdatedAt, item.updatedAt);
        continue;
      }
      if (!shouldCapture(item.updatedAt, options.lastSync)) {
        skipped += 1;
        continue;
      }

      try {
        const detailEndpoint = `/backend-api/conversation/${encodeURIComponent(item.id)}`;
        const payload = await fetchJson(fetcher, detailEndpoint, { headers });
        const candidates = chatgptAssetCandidates(payload, item.id, headers);
        const assets = await uploadProviderAssets(
          fetcher,
          options.uploadAsset,
          candidates,
          { resolveUrl: candidate => resolveChatgptAssetUrl(fetcher, candidate) },
        );
        const didCapture = await options.emitCapture(buildRawCapture({
          source: "chatgpt",
          sourceId: item.id,
          endpoint: detailEndpoint,
          payload,
          assets,
    assetReferences: assetReferences(candidates),
          conversationUpdatedAt: item.updatedAt,
          rawUrl: `${currentOrigin()}${detailEndpoint}`,
        }));
        failures.succeeded(item.id);
        if (didCapture === false) {
          skipped += 1;
          continue;
        }
        captured += 1;
        maxConversationUpdatedAt = maxIso(maxConversationUpdatedAt, item.updatedAt);
      } catch (error) {
        if (isRateLimitError(error)) throw error;
        failed++;
        failures.failed(item.id, item.updatedAt);
        if (failures.isQuarantined(item.id, item.updatedAt)) maxConversationUpdatedAt = maxIso(maxConversationUpdatedAt, item.updatedAt);
        logSyncFailure("chatgpt", item.id);
      }
    }

    offset += items.length;
    if (items.length < LIST_LIMIT) break;
  }

  return { source: "chatgpt", scanned, captured, skipped, failed, captureFailures: failures.list(), maxConversationUpdatedAt: failures.pending ? options.lastSync ?? null : maxConversationUpdatedAt, account: null };
}

function currentOrigin(): string | null {
  return typeof location === "undefined" ? null : location.origin;
}

async function getAccessToken(fetcher: FetchLike): Promise<string | null> {
  try {
    const session = asObject(await fetchJson(fetcher, "/api/auth/session"));
    return typeof session.accessToken === "string" ? session.accessToken : null;
  } catch (error) {
    if (isRateLimitError(error)) throw error;
    return null;
  }
}

function readChatgptItems(page: Record<string, unknown>): ConversationSummary[] {
  return asArray(page.items ?? page.conversations).flatMap((raw) => {
    const item = asObject(raw);
    const id = item.id ?? item.conversation_id;
    if (typeof id !== "string" || id === "") return [];
    return [{
      id,
      updatedAt: readIso(item.update_time ?? item.updated_at ?? item.create_time ?? item.created_at),
    }];
  });
}

function readIso(value: unknown): string | null {
  if (typeof value === "string") {
    const epochMs = epochStringMs(value);
    return epochMs === null ? value : new Date(epochMs).toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value < 10_000_000_000 ? value * 1000 : value).toISOString();
  }
  return null;
}

function epochStringMs(value: string): number | null {
  const raw = value.trim();
  if (/^\d{10}$/.test(raw)) return Number(raw) * 1000;
  if (/^\d{13}$/.test(raw)) return Number(raw);
  return null;
}
