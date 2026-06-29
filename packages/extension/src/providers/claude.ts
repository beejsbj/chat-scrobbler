import { buildRawCapture } from "../../../shared/src";
import {
  asArray,
  asObject,
  fetchJson,
  maxIso,
  shouldCapture,
  type ConversationSummary,
  type FetchLike,
  type ProviderAdapter,
  type ProviderSyncOptions,
  type ProviderSyncResult,
} from "./types";

const LIST_LIMIT = 50;

export function createClaudeAdapter(fetcher: FetchLike = fetch.bind(globalThis)): ProviderAdapter {
  return {
    source: "claude",
    sync: (options) => syncClaude(fetcher, options),
    listConversations: (pages = 1) => listClaude(fetcher, pages),
    captureOne: (id, updatedAt, emitCapture) => captureClaudeOne(fetcher, id, updatedAt, emitCapture),
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
  emitCapture: ProviderSyncOptions["emitCapture"],
): Promise<void> {
  const org = await getOrganization(fetcher);
  const detailEndpoint = `/api/organizations/${encodeURIComponent(org.uuid)}/chat_conversations/${encodeURIComponent(id)}?tree=True&rendering_mode=messages&render_all_tools=true`;
  const payload = await fetchJson(fetcher, detailEndpoint);
  await emitCapture(buildRawCapture({
    source: "claude",
    sourceId: id,
    endpoint: detailEndpoint,
    account: org.uuid,
    payload,
    conversationUpdatedAt: updatedAt,
    rawUrl: `${currentOrigin()}${detailEndpoint}`,
  }));
}

async function syncClaude(fetcher: FetchLike, options: ProviderSyncOptions): Promise<ProviderSyncResult> {
  const org = await getOrganization(fetcher);
  let offset = 0;
  let scanned = 0;
  let captured = 0;
  let skipped = 0;
  let maxConversationUpdatedAt: string | null = null;

  while (true) {
    const endpoint = `/api/organizations/${encodeURIComponent(org.uuid)}/chat_conversations?limit=${LIST_LIMIT}&offset=${offset}`;
    const page = await fetchJson(fetcher, endpoint);
    const items = readClaudeItems(page);
    if (items.length === 0) break;

    for (const item of items) {
      scanned += 1;
      maxConversationUpdatedAt = maxIso(maxConversationUpdatedAt, item.updatedAt);
      if (options.shouldIgnore?.("claude", item.id)) {
        skipped += 1;
        continue;
      }
      if (!shouldCapture(item.updatedAt, options.lastSync)) {
        skipped += 1;
        continue;
      }

      // tree=True + rendering_mode are REQUIRED: the plain detail endpoint returns
      // messages with a flat `text` field but no typed `content[]` blocks, silently
      // dropping thinking/tool_use/tool_result/citations. Verified live 2026-06-05
      // (see docs/superpowers/specs/2026-06-05-api-vs-export-validation-diff.md).
      const detailEndpoint = `/api/organizations/${encodeURIComponent(org.uuid)}/chat_conversations/${encodeURIComponent(item.id)}?tree=True&rendering_mode=messages&render_all_tools=true`;
      const payload = await fetchJson(fetcher, detailEndpoint);
      await options.emitCapture(buildRawCapture({
        source: "claude",
        sourceId: item.id,
        endpoint: detailEndpoint,
        account: org.uuid,
        payload,
        conversationUpdatedAt: item.updatedAt,
        rawUrl: `${currentOrigin()}${detailEndpoint}`,
      }));
      captured += 1;
    }

    offset += items.length;
    if (items.length < LIST_LIMIT) break;
  }

  return {
    source: "claude",
    scanned,
    captured,
    skipped,
    maxConversationUpdatedAt,
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
