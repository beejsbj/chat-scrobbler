// src/parsers/claude.ts
// Shared builders + live capture parser for Claude.
// Historical canonical files may carry capture_method "export"; this file only
// WRITES capture_method "api" for new captures.
import type { Session, Message, Block } from "../schema/types";
import { makeSessionId } from "../schema/types";
import { assetLookupFromRaw, type AssetLookup } from "./assets";
import { renderText } from "./render";

export function toIso(s?: string | null): string | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toISOString();
}

export interface RawClaudeMsg {
  uuid: string; sender: "human" | "assistant";
  created_at?: string | null; parent_message_uuid?: string | null;
  text?: string; content?: any[];
  attachments?: any[];
  files?: any[];
}
export interface RawClaudeConv {
  uuid: string; name?: string | null;
  created_at?: string; updated_at?: string; account?: any;
  chat_messages?: RawClaudeMsg[];
}

export function blocksFromClaude(m: RawClaudeMsg, assets: AssetLookup = assetLookupFromRaw(null)): Block[] {
  const blocks: Block[] = [];
  for (const c of m.content ?? []) {
    switch (c?.type) {
      case "text":
        if (c.text?.trim()) blocks.push({ type: "text", text: c.text });
        break;
      case "voice_note":
        if (c.text?.trim()) blocks.push({ type: "text", text: c.text });
        break;
      case "thinking":
        if (c.thinking?.trim()) blocks.push({ type: "reasoning", text: c.thinking });
        break;
      case "tool_use":
        if (c.name === "artifacts" && c.input) {
          blocks.push({ type: "artifact", artifact_id: c.input.id ?? "", kind: c.input.type ?? "",
            title: c.input.title ?? null, version: c.input.version_uuid ?? null, content: c.input.content ?? "" });
        } else {
          blocks.push({ type: "tool_call", name: c.name ?? "tool", input: c.input ?? null });
        }
        break;
      case "tool_result": {
        const out = Array.isArray(c.content) ? c.content.map((x: any) => x?.text ?? "").join("\n") : c.content;
        blocks.push({ type: "tool_result", name: c.name ?? "tool", output: out });
        break;
      }
    }
  }
  if (blocks.length === 0 && m.text?.trim()) blocks.push({ type: "text", text: m.text });
  for (const f of m.files ?? []) {
    const pointer = f.file_uuid ?? f.uuid ?? f.id ?? "";
    blocks.push({
      type: "attachment",
      kind: "file",
      filename: f.file_name ?? f.filename ?? null,
      pointer,
      local_path: assets.byPointer(pointer)?.local_path ?? null,
    });
  }
  for (const a of m.attachments ?? []) {
    const pointer = a.file_uuid ?? a.uuid ?? a.id ?? a.attachment_uuid ?? "";
    if (!pointer) continue;
    blocks.push({
      type: "attachment",
      kind: "file",
      filename: a.file_name ?? a.filename ?? a.name ?? null,
      pointer,
      local_path: assets.byPointer(pointer)?.local_path ?? null,
    });
  }
  return blocks;
}

/** Map one Claude `chat_messages[]` entry to a canonical Message, or null if it
 *  yields no blocks. */
export function claudeMessageToCanonical(m: RawClaudeMsg, assets: AssetLookup = assetLookupFromRaw(null)): Message | null {
  if (!m.uuid) return null;
  const role = m.sender === "human" ? "user" : "assistant";
  const blocks = blocksFromClaude(m, assets);
  if (blocks.length === 0) return null;
  return {
    id: m.uuid,
    role,
    created_at: toIso(m.created_at),
    parent_id: m.parent_message_uuid ?? null,
    model: null,
    blocks,
    text: renderText(blocks),
  };
}

interface MaybeEnvelope { payload?: unknown; account?: string | null; }

interface ApiClaudeConv extends RawClaudeConv {
  current_leaf_message_uuid?: string | null;
  model?: string | null;
}

/** Parse a live Claude capture (RawCapture envelope or bare conversation).
 *  Emits ALL chat_messages that yield blocks, keeping payload order.
 *  parent_id is normalized to the nearest emitted ancestor.
 *  active_leaf_id = nearest emitted message on the current_leaf_message_uuid chain. */
export function parseClaude(raw: unknown): Session[] {
  if (!raw || typeof raw !== "object") return [];
  const env = raw as MaybeEnvelope;
  const account = typeof env.account === "string" ? env.account : null;
  const payload = "payload" in env && env.payload ? env.payload : raw;
  const conversations = Array.isArray(payload) ? payload : [payload];
  const sessions: Session[] = [];
  const assets = assetLookupFromRaw(raw);
  for (const conv of conversations as ApiClaudeConv[]) {
    if (!conv?.uuid) continue;
    const rawMsgs = conv.chat_messages ?? [];
    // Build a map from uuid -> raw message for ancestor-walk lookups.
    const byUuid = new Map<string, RawClaudeMsg>();
    for (const m of rawMsgs) if (m?.uuid) byUuid.set(m.uuid, m);

    // Track which uuids were emitted and map them to canonical message ids.
    const emittedUuids = new Set<string>();
    const messages: Message[] = [];

    for (const m of rawMsgs) {
      const canonical = claudeMessageToCanonical(m, assets);
      if (!canonical) continue;
      emittedUuids.add(m.uuid);
      // Normalize parent_id: walk parent_message_uuid chain until we find an
      // emitted ancestor (or reach a null/unknown parent).
      let parentUuid: string | null = m.parent_message_uuid ?? null;
      let resolvedParentId: string | null = null;
      const seen = new Set<string>();
      while (parentUuid && !seen.has(parentUuid)) {
        seen.add(parentUuid);
        if (emittedUuids.has(parentUuid)) {
          resolvedParentId = parentUuid; // uuid == canonical message id for Claude
          break;
        }
        const parentMsg = byUuid.get(parentUuid);
        parentUuid = parentMsg?.parent_message_uuid ?? null;
      }
      canonical.parent_id = resolvedParentId;
      messages.push(canonical);
    }

    // active_leaf_id: nearest emitted message on the current_leaf_message_uuid chain.
    let activeLeafId: string | null = null;
    let cur: string | null = conv.current_leaf_message_uuid ?? null;
    const chainSeen = new Set<string>();
    while (cur && !chainSeen.has(cur)) {
      chainSeen.add(cur);
      if (emittedUuids.has(cur)) {
        activeLeafId = cur;
        break;
      }
      const msg = byUuid.get(cur);
      cur = msg?.parent_message_uuid ?? null;
    }

    const created = toIso(conv.created_at) ?? new Date(0).toISOString();
    sessions.push({
      id: makeSessionId("claude", conv.uuid),
      source: "claude",
      source_id: conv.uuid,
      capture_method: "api",
      title: conv.name ?? null,
      created_at: created,
      updated_at: toIso(conv.updated_at) ?? created,
      default_model: conv.model ?? null,
      // account is the org, carried in the capture envelope (no conv-level account on the API)
      account: account ?? (conv.account && typeof conv.account === "object" ? conv.account.uuid ?? null : null),
      messages,
      active_leaf_id: activeLeafId,
      raw_ref: `raw/api/claude:${conv.uuid}`,
      schema_version: 1,
    });
  }
  return sessions;
}
