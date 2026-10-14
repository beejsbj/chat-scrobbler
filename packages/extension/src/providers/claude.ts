import { DetailFailureStreak } from "./detail-failure-streak";
import { abortTransientCapture } from "./sync-errors";
import { logSyncFailure, SyncFailureTracker } from "./sync-failures";
import { buildRawCapture } from "../../../shared/src";
import { assetReferences, uploadProviderAssets } from "./assets";
import { claudeAssetCandidates, claudeSandboxDownloadEndpoint, claudeUnverifiedFileDownloadEndpoint } from "./claude-assets";
import {
  asArray,
  asObject,
  fetchJson,
  fetchDetailJson,
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

export function createClaudeAdapter(fetcher: FetchLike = fetch.bind(globalThis)): ProviderAdapter {
  return {
    source: "claude",
    backfillAssets: async (id, references, options) => {
      const org = await getOrganization(fetcher);
      await options.beforeFetch();
      const endpoint = `/api/organizations/${encodeURIComponent(org.uuid)}/chat_conversations/${encodeURIComponent(id)}?tree=True&rendering_mode=messages&render_all_tools=true`;
      let refreshed = new Map<string, ReturnType<typeof claudeAssetCandidates>[number]>();
      try { refreshed = new Map(claudeAssetCandidates(await fetchJson(fetcher, endpoint), id, org.uuid).map(candidate => [candidate.pointer, candidate])); }
      catch (error) {
        abortTransientCapture(error);
        // Existing pointers still get their own bounded download attempt and failure report.
      }
      return uploadProviderAssets(fetcher, options.uploadAsset, references.map(ref => ({
        source: "claude", sourceId: id, pointer: ref.pointer, messageId: ref.message_id,
        filename: ref.filename, contentType: ref.content_type, inlineBytes: refreshed.get(ref.pointer)?.inlineBytes, inlineBase64: refreshed.get(ref.pointer)?.inlineBase64,
        url: refreshed.get(ref.pointer)?.url ?? (ref.pointer.startsWith("claude-inline:") ? null
          : ref.pointer.startsWith("sandbox:") ? claudeSandboxDownloadEndpoint(org.uuid, id, ref.pointer.slice(8))
          : ref.pointer.startsWith("/mnt/") ? claudeSandboxDownloadEndpoint(org.uuid, id, ref.pointer)
          : /^(https?:|data:|blob:|\/)/.test(ref.pointer) ? ref.pointer
          : claudeUnverifiedFileDownloadEndpoint(org.uuid, ref.pointer)),
      })), { beforeFetch: options.beforeFetch });
    },
    sync: (options) => syncClaude(fetcher, options),
    listConversations: (pages = 1) => listClaude(fetcher, pages),
    captureOne: (id, updatedAt, options) => captureClaudeOne(fetcher, id, updatedAt, options),
  };
}

async function listClaude(fetcher: FetchLike, pages: number): Promise<ConversationSummary[]> {
  const org = await getOrganization(fetcher);
  const out: ConversationSummary[] = [];
  for (let page = 0; page < pages; page++) {
    const endpoint = `/api/organizations/${encodeURIComponent(org.uuid)}/chat_conversations?limit=${LIST_LIMIT}&offset=${page * LIST_LIMIT}`;
    const items = readClaudeItems(await fetchJson(fetcher, endpoint));
    if (items.length === 0) break;
    out.push(...items);
    if (items.length < LIST_LIMIT) break;
  }
  return out;
}

async function captureClaudeOne(
  fetcher: FetchLike,
  id: string,
  updatedAt: string | null,
  options: ProviderCaptureOneOptions,
): Promise<void> {
  const org = await getOrganization(fetcher);
  const detailEndpoint = `/api/organizations/${encodeURIComponent(org.uuid)}/chat_conversations/${encodeURIComponent(id)}?tree=True&rendering_mode=messages&render_all_tools=true`;
  const payload = await fetchDetailJson(fetcher, detailEndpoint);
  const candidates = claudeAssetCandidates(payload, id, org.uuid);
  const assets = await uploadProviderAssets(
    fetcher,
    options.uploadAsset,
    candidates,
  );
  await options.emitCapture(buildRawCapture({
    source: "claude",
    sourceId: id,
    endpoint: detailEndpoint,
    account: org.uuid,
    payload,
    assets,
    assetReferences: assetReferences(candidates),
    conversationUpdatedAt: updatedAt,
    rawUrl: `${currentOrigin()}${detailEndpoint}`,
  }));
}

async function syncClaude(fetcher: FetchLike, options: ProviderSyncOptions): Promise<ProviderSyncResult> {
  const org = await getOrganization(fetcher);
  let offset = 0;
  const failures = new SyncFailureTracker((options.captureFailures ?? []).filter(f => !options.shouldIgnore?.("claude", f.source_id)));
  const detailFailures = new DetailFailureStreak((options.detailFailureStreak ?? []).filter(f => !options.shouldIgnore?.("claude", f.source_id)));
  let scanned = 0;
  let captured = 0;
  let skipped = 0;
  let failed = 0;
  let maxConversationUpdatedAt: string | null = null;

  while (true) {
    const endpoint = `/api/organizations/${encodeURIComponent(org.uuid)}/chat_conversations?limit=${LIST_LIMIT}&offset=${offset}`;
    const page = await fetchJson(fetcher, endpoint);
    const items = readClaudeItems(page);
    if (items.length === 0) break;

    for (const item of items) {
      failures.observed(item.id);
      const retry = failures.shouldRetry(item.id, item.updatedAt);
      scanned += 1;
      if (options.shouldIgnore?.("claude", item.id)) {
        failures.succeeded(item.id);
        skipped += 1;
        continue;
      }
      if (failures.isQuarantined(item.id, item.updatedAt)) {
        skipped++;
        maxConversationUpdatedAt = maxIso(maxConversationUpdatedAt, item.updatedAt);
        continue;
      }
      if (!retry && !shouldCapture(item.updatedAt, options.lastSync)) {
        skipped += 1;
        continue;
      }

      // tree=True + rendering_mode are REQUIRED: the plain detail endpoint returns
      // messages with a flat `text` field but no typed `content[]` blocks, silently
      // dropping thinking/tool_use/tool_result/citations. Verified live 2026-06-05
      // (see docs/superpowers/specs/2026-06-05-api-vs-export-validation-diff.md).
      try {
        const detailEndpoint = `/api/organizations/${encodeURIComponent(org.uuid)}/chat_conversations/${encodeURIComponent(item.id)}?tree=True&rendering_mode=messages&render_all_tools=true`;
        const payload = await fetchDetailJson(fetcher, detailEndpoint);
        const candidates = claudeAssetCandidates(payload, item.id, org.uuid);
        const assets = await uploadProviderAssets(
          fetcher,
          options.uploadAsset,
          candidates,
        );
        const didCapture = await options.emitCapture(buildRawCapture({
          source: "claude",
          sourceId: item.id,
          endpoint: detailEndpoint,
          account: org.uuid,
          payload,
          assets,
          assetReferences: assetReferences(candidates),
          conversationUpdatedAt: item.updatedAt,
          rawUrl: `${currentOrigin()}${detailEndpoint}`,
        }));
        detailFailures.succeeded(item.id);
        failures.succeeded(item.id);
        if (didCapture === false) {
          skipped += 1;
          continue;
        }
        captured += 1;
        maxConversationUpdatedAt = maxIso(maxConversationUpdatedAt, item.updatedAt);
      } catch (error) {
        detailFailures.failed(error, item.id, item.updatedAt);
        failed++;
        failures.failed(item.id, item.updatedAt);
        if (failures.isQuarantined(item.id, item.updatedAt)) maxConversationUpdatedAt = maxIso(maxConversationUpdatedAt, item.updatedAt);
        logSyncFailure("claude", item.id);
      }
    }

    offset += items.length;
    if (items.length < LIST_LIMIT) break;
  }

  detailFailures.finish();
  failures.finishListing();
  return {
    source: "claude",
    scanned,
    captured,
    skipped,
    failed,
    captureFailures: failures.list(), detailFailureStreak: detailFailures.snapshot(), maxConversationUpdatedAt: failures.pending ? options.lastSync ?? null : maxConversationUpdatedAt,
    account: org.uuid,
  };
}

function currentOrigin(): string | null {
  return typeof location === "undefined" ? null : location.origin;
}

async function getOrganization(fetcher: FetchLike): Promise<{ uuid: string }> {
  const raw = await fetchJson(fetcher, "/api/organizations");
  const orgs = asArray(asObject(raw).organizations ?? raw);
  const first = asObject(orgs[0]);
  const uuid = first.uuid ?? first.id;
  if (typeof uuid !== "string" || uuid === "") throw new Error("Claude organization not found");
  return { uuid };
}

function readClaudeItems(page: unknown): ConversationSummary[] {
  const object = asObject(page);
  const rows = asArray(object.data ?? object.chat_conversations ?? object.conversations ?? page);
  return rows.flatMap((raw) => {
    const item = asObject(raw);
    const id = item.uuid ?? item.id;
    if (typeof id !== "string" || id === "") return [];
    return [{
      id,
      updatedAt: readIso(item.updated_at ?? item.updatedAt ?? item.created_at),
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
