// src/parsers/chatgpt.ts
// Shared builders + live capture parser for ChatGPT.
// Historical canonical files may carry capture_method "export"; this file only
// WRITES capture_method "api" for new captures.
import type { Session, Message, Block, CaptureMethod } from "../schema/types";
import { makeSessionId } from "../schema/types";
import { assetLookupFromRaw, type AssetLookup } from "./assets";
import { renderText } from "./render";

export interface RawNode { id: string; message: any | null; parent: string | null; children?: string[]; }
export interface RawConversation {
  conversation_id?: string; id?: string; title?: string | null;
  create_time?: number | null; update_time?: number | null;
  default_model_slug?: string | null; current_node?: string | null;
  mapping: Record<string, RawNode>;
}

export const epochToIso = (t?: number | null): string | null =>
  typeof t === "number" ? new Date(t * 1000).toISOString() : null;

export function blocksFromContent(content: any, assets: AssetLookup = assetLookupFromRaw(null)): Block[] {
  if (!content) return [];
  const ct = content.content_type;
  if (ct === "text") {
    const text = (content.parts ?? []).filter((p: any) => typeof p === "string").join("\n").trim();
    return text ? [{ type: "text", text }] : [];
  }
  if (ct === "multimodal_text") {
    const blocks: Block[] = [];
    for (const part of content.parts ?? []) {
      if (typeof part === "string") {
        if (part.trim()) blocks.push({ type: "text", text: part });
      } else if (part?.content_type === "audio_transcription" && part.text) {
        blocks.push({ type: "text", text: part.text });
      } else if (part?.content_type === "image_asset_pointer") {
        const pointer = part.asset_pointer ?? "";
        blocks.push({ type: "attachment", kind: "image", filename: null, pointer, local_path: assets.byPointer(pointer)?.local_path ?? null });
      } else if (part?.asset_pointer || part?.audio_asset_pointer) {
        const ptr = part.asset_pointer ?? part.audio_asset_pointer?.asset_pointer ?? "";
        blocks.push({ type: "attachment", kind: "audio", filename: null, pointer: ptr, local_path: assets.byPointer(ptr)?.local_path ?? null });
      }
    }
    return blocks;
  }
  if (ct === "thoughts") {
    const text = (content.thoughts ?? []).map((t: any) => t?.content).filter(Boolean).join("\n\n").trim();
    return text ? [{ type: "reasoning", text }] : [];
  }
  if (ct === "reasoning_recap") {
    return content.content ? [{ type: "reasoning", text: String(content.content) }] : [];
  }
  // API-only content types (tool I/O + system memory).
  if (ct === "code") {
    return [{ type: "tool_call", name: "code", input: content.text ?? content.parts ?? null }];
  }
  if (ct === "execution_output") {
    const out = content.text ?? (Array.isArray(content.parts) ? content.parts.join("\n") : null);
    return [{ type: "tool_result", name: "code", output: out }];
  }
  if (ct === "model_editable_context" || ct === "user_editable_context") {
    const text = [content.model_set_context, content.profile, content.instructions]
      .filter((s: any) => typeof s === "string" && s.trim()).join("\n\n").trim();
    return text ? [{ type: "reasoning", text }] : [];
  }
  // fallback -- never silently drop (raw retains full fidelity)
  if (Array.isArray(content.parts)) {
    const text = content.parts.filter((p: any) => typeof p === "string").join("\n").trim();
    return text ? [{ type: "text", text }] : [];
  }
  if (typeof content.text === "string" && content.text.trim()) return [{ type: "text", text: content.text }];
  return [];
}

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
    const blocks = blocksFromContent(m.content, assets);
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
    schema_version: 1,
  };
}

interface MaybeEnvelope { payload?: unknown; account?: string | null; }

/** Parse a live ChatGPT capture (RawCapture envelope or bare conversation). */
export function parseChatgpt(raw: unknown): Session[] {
  if (!raw || typeof raw !== "object") return [];
  const env = raw as MaybeEnvelope;
  const account = typeof env.account === "string" ? env.account : null;
  // RawCapture envelope carries provider JSON at .payload; tolerate a bare payload too.
  const payload = "payload" in env && env.payload ? env.payload : raw;
  const conversations = Array.isArray(payload) ? payload : [payload];
  const sessions: Session[] = [];
  const assets = assetLookupFromRaw(raw);
  for (const conv of conversations as RawConversation[]) {
    const sourceId = conv?.conversation_id ?? conv?.id;
    const session = sessionFromChatgptConversation(conv, {
      capture_method: "api",
      raw_ref: `raw/api/chatgpt:${sourceId}`,
      account,
      assets,
    });
    if (session) sessions.push(session);
  }
  return sessions;
}
