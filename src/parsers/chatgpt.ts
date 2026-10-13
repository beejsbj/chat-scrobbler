// src/parsers/chatgpt.ts
// Shared builders + live capture parser for ChatGPT.
// Historical canonical files may carry capture_method "export"; this file only
// WRITES capture_method "api" for new captures.
import type { Session, Message, Block, CaptureMethod } from "../schema/types";
import { SCHEMA_VERSION, makeSessionId } from "../schema/types";
import { assetLookupFromRaw, type AssetLookup } from "./assets";
import { renderText } from "./render";
import { blocksFromContent } from "./chatgpt-parts";
export { blocksFromContent } from "./chatgpt-parts";
import { childLocation, toolCall, unknownBlock, type ParserContext } from "./parts";

export interface RawNode { id: string; message: any | null; parent: string | null; children?: string[]; }
export interface RawConversation {
  conversation_id?: string; id?: string; title?: string | null;
  create_time?: number | null; update_time?: number | null;
  default_model_slug?: string | null; current_node?: string | null;
  mapping: Record<string, RawNode>;
}

export const epochToIso = (t?: number | null): string | null =>
  typeof t === "number" ? new Date(t * 1000).toISOString() : null;

/** @deprecated  Use sessionFromChatgptConversation which now emits the full tree. */
export function linearPath(conv: RawConversation): RawNode[] {
  const nodes: RawNode[] = [];
  const seen = new Set<string>();
  let cur = conv.current_node ?? null;
  while (cur && conv.mapping[cur] && !seen.has(cur)) {
    seen.add(cur);
    nodes.push(conv.mapping[cur]);
    cur = conv.mapping[cur].parent;
  }
  return nodes.reverse();
}

/** Find the root node (the one with no parent, or parent not in mapping). */
function findRoot(mapping: Record<string, RawNode>): string | null {
  for (const [id, node] of Object.entries(mapping)) {
    if (!node.parent || !mapping[node.parent]) return id;
  }
  // Fallback: pick any key (should not happen in valid data).
  const keys = Object.keys(mapping);
  return keys.length ? keys[0] : null;
}

/** Depth-first traversal of the mapping tree, returning nodes in DFS pre-order.
 *  Follows each node's children array to preserve original child ordering. */
function depthFirstNodes(mapping: Record<string, RawNode>): RawNode[] {
  const rootId = findRoot(mapping);
  if (!rootId) return [];
  const result: RawNode[] = [];
  const seen = new Set<string>();
  const stack: string[] = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id) || !mapping[id]) continue;
    seen.add(id);
    result.push(mapping[id]);
    // Push children in reverse order so the first child is processed first.
    const children = mapping[id].children ?? [];
    for (let i = children.length - 1; i >= 0; i--) {
      if (!seen.has(children[i])) stack.push(children[i]);
    }
  }
  return result;
}

export interface ChatgptSessionOptions {
  capture_method: CaptureMethod;
  raw_ref: string;
  account?: string | null;
  assets?: AssetLookup;
  raw_path?: string;
}

/** Build one canonical Session from a single ChatGPT `mapping`-tree conversation.
 *  Emits ALL nodes that survive role + blocks filters (not just the active branch),
 *  in depth-first order. Every non-null parent_id resolves within messages[].
 *  active_leaf_id is the nearest emitted node on the current_node ancestor chain. */
export function sessionFromChatgptConversation(conv: RawConversation, opts: ChatgptSessionOptions): Session | null {
  const sourceId = conv.conversation_id ?? conv.id;
  if (!sourceId || !conv.mapping) return null;
  const assets = opts.assets ?? assetLookupFromRaw(null);

  // Pass 1: collect all emitted messages in DFS order.
  // Track which raw node ids were emitted and what message id each maps to.
  const rawToEmittedId = new Map<string, string>(); // rawNodeId -> emitted message id
  const messages: Message[] = [];

  for (const node of depthFirstNodes(conv.mapping)) {
    const m = node.message;
    if (!m) continue;
    const role = m.author?.role;
    if (role !== "user" && role !== "assistant" && role !== "tool" && role !== "system") continue;
    const location = childLocation({ raw_ref: opts.raw_ref, raw_path: opts.raw_path ?? "" }, "mapping", node.id, "message");
    const recipient = typeof m.recipient === "string" && m.recipient !== "all" ? m.recipient : null;
    const name = recipient ?? (role === "tool" ? m.author?.name : null) ?? "code";
    const blocks = recipient || role === "tool"
      ? [toolCall(name)] : blocksFromContent(m.content, assets, childLocation(location, "content"));
    for (const key of ["citations", "content_references", "attachments"]) {
      const entries = m.metadata?.[key];
      if (Array.isArray(entries)) entries.forEach((entry: unknown, i: number) =>
        blocks.push(unknownBlock(entry, childLocation(location, "metadata", key, i), key)));
    }
    if (blocks.length === 0) continue;
    const msgId = m.id ?? node.id;
    rawToEmittedId.set(node.id, msgId);
    // parent_id: walk up raw node parents through filtered-out nodes until we
    // find one that was emitted, or reach the root.
    let parentRawId: string | null = node.parent ?? null;
    let resolvedParentId: string | null = null;
    const visited = new Set<string>();
    while (parentRawId && !visited.has(parentRawId)) {
      visited.add(parentRawId);
      if (rawToEmittedId.has(parentRawId)) {
        resolvedParentId = rawToEmittedId.get(parentRawId)!;
        break;
      }
      parentRawId = conv.mapping[parentRawId]?.parent ?? null;
    }
    messages.push({
      id: msgId,
      role,
      created_at: epochToIso(m.create_time),
      parent_id: resolvedParentId,
      model: m.metadata?.model_slug ?? null,
      blocks,
      text: renderText(blocks),
    });
  }

  // active_leaf_id: nearest emitted node on the current_node ancestor chain.
  let activeLeafId: string | null = null;
  let cur: string | null = conv.current_node ?? null;
  const chainSeen = new Set<string>();
  while (cur && conv.mapping[cur] && !chainSeen.has(cur)) {
    chainSeen.add(cur);
    if (rawToEmittedId.has(cur)) {
      activeLeafId = rawToEmittedId.get(cur)!;
      break;
    }
    cur = conv.mapping[cur].parent ?? null;
  }

  const created = epochToIso(conv.create_time) ?? new Date(0).toISOString();
  return {
    id: makeSessionId("chatgpt", sourceId),
    source: "chatgpt",
    source_id: sourceId,
    capture_method: opts.capture_method,
    title: conv.title ?? null,
    created_at: created,
    updated_at: epochToIso(conv.update_time) ?? created,
    default_model: conv.default_model_slug ?? null,
    account: opts.account ?? null,
    messages,
    active_leaf_id: activeLeafId,
    raw_ref: opts.raw_ref,
    schema_version: SCHEMA_VERSION,
  };
}

interface MaybeEnvelope { payload?: unknown; account?: string | null; }

/** Parse a live ChatGPT capture (RawCapture envelope or bare conversation). */
export function parseChatgpt(raw: unknown, context: ParserContext = {}): Session[] {
  if (!raw || typeof raw !== "object") return [];
  const env = raw as MaybeEnvelope;
  const account = typeof env.account === "string" ? env.account : null;
  // RawCapture envelope carries provider JSON at .payload; tolerate a bare payload too.
  const payload = "payload" in env && env.payload ? env.payload : raw;
  const conversations = Array.isArray(payload) ? payload : [payload];
  const sessions: Session[] = [];
  const assets = assetLookupFromRaw(raw);
  for (const [index, conv] of (conversations as RawConversation[]).entries()) {
    const sourceId = conv?.conversation_id ?? conv?.id;
    const session = sessionFromChatgptConversation(conv, {
      capture_method: "api",
      raw_ref: context.raw_ref ?? `raw/api/chatgpt:${sourceId}`,
      raw_path: ("payload" in env ? "/payload" : "") + (Array.isArray(payload) ? `/${index}` : ""),
      account,
      assets,
    });
    if (session) sessions.push(session);
  }
  return sessions;
}
