// packages/ingest/src/status.ts
// Spine-awareness: given the conversations a provider's sidebar is showing
// (id + updated_at), report which are already in the index and fresh. This is
// what stops the extension from re-capturing the thousands of conversations the
// exports already put in the spine, and what drives the sidebar badges.
import type { Database } from "bun:sqlite";
import { indexedConversations } from "../../../src/indexer/sqlite";

export type ConversationState = "synced" | "stale" | "missing";

export interface StatusQueryItem {
  id: string;
  updated_at?: string | null;
}

const ts = (v?: string | null): number => {
  if (!v) return 0;
  const n = Date.parse(v);
  if (Number.isFinite(n)) return n;
  const raw = v.trim();
  if (/^\d{10}$/.test(raw)) return Number(raw) * 1000;
  if (/^\d{13}$/.test(raw)) return Number(raw);
  return 0;
};

export function conversationStatuses(
  db: Database,
  source: string,
  conversations: StatusQueryItem[],
): Record<string, ConversationState> {
  const ids = conversations.map((c) => c.id).filter((id): id is string => typeof id === "string" && id !== "");
  const indexed = indexedConversations(db, source, ids);
  const out: Record<string, ConversationState> = {};
  for (const c of conversations) {
    if (typeof c.id !== "string" || c.id === "") continue;
    const have = indexed.get(c.id);
    if (have === undefined) {
      out[c.id] = "missing";
    } else if (ts(have) >= ts(c.updated_at)) {
      out[c.id] = "synced";
    } else {
      out[c.id] = "stale";
    }
  }
  return out;
}
