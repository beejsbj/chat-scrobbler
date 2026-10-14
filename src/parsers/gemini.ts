// src/parsers/gemini.ts
// Parser for live Gemini captures coming from the browser-extension scrobbler.
//
// Capture path:
//   Extension -> hNvQHb batchexecute RPC -> parseBatchExecuteResponse ->
//   RawCapture.payload = the inner hNvQHb JSON array -> parseGemini -> canonical Session
//
// hNvQHb inner array structure (verified against live data, 2026-06-06):
//
//   payload[0] = turns[]          -- conversation exchanges
//   payload[1] = null             -- unused
//   payload[2] = null             -- unused
//   payload[3] = []               -- unused
//
// Each turn in payload[0]:
//   turn[0] = [c_<convId>, r_<userMsgId>]
//   turn[1] = [c_<convId>, r_<respMsgId>, rc_<selectedChoiceId>] | null
//   turn[2] = [[...userTextStrings], roleInt, null, int, hexId, int, null, null, bool]
//   turn[3] = response data (26-element array):
//     turn[3][0] = [[candidate_0], [candidate_1], ...]  -- response candidates
//     turn[3][3] = rc_<defaultCandidateId>              -- default candidate rc id
//     turn[3][21] = model name string (e.g. "3.5 Flash")
//   turn[4] = [epochSeconds, nanoseconds]               -- assistant response timestamp
//
// Each candidate in turn[3][0]:
//   candidate[0] = rc_<choiceId>
//   candidate[1] = [text_part_string, ...]              -- response text parts
//
// All candidates are retained. Provider selection determines the active branch.
// The conversation ID comes from the capture envelope source_id (no c_ prefix).
// The title is not present in hNvQHb; the envelope may carry an explicit title or
// be null -- parsers do not fabricate it.

import type { Session, Message } from "../schema/types";
import { SCHEMA_VERSION, makeSessionId } from "../schema/types";
import { assetLookupFromRaw } from "./assets";
import { addCapturedAssets, capturedAssetBlocks } from "./captured-assets";
import { renderText } from "./render";
import { childLocation, limitUnknownJson, type ParserContext } from "./parts";
import { geminiTextParts, geminiOpaqueSlots, geminiCandidates } from "./gemini-parts";

// Epoch seconds + nanoseconds [s, ns] array -- the timestamp type Gemini uses.
type GeminiTimestamp = [number, number] | null | undefined;

function timestampToIso(ts: GeminiTimestamp): string | null {
  if (!Array.isArray(ts) || typeof ts[0] !== "number") return null;
  return new Date(ts[0] * 1000).toISOString();
}

// Each turn is: [userRef, respRef | null, userMeta, respData, assistantTimestamp]
type Turn = unknown[];

function extractModel(turn: Turn): string | null {
  const respData = turn[3];
  if (!Array.isArray(respData)) return null;
  const model = respData[21];
  return typeof model === "string" && model.trim() ? model.trim() : null;
}

function extractUserMsgId(turn: Turn): string | null {
  const userRef = turn[0];
  if (!Array.isArray(userRef)) return null;
  return typeof userRef[1] === "string" ? userRef[1] : null;
}

function extractAssistantTimestamp(turn: Turn): string | null {
  return timestampToIso(turn[4] as GeminiTimestamp);
}

/** Determine the selected candidate rc id for a turn.
 *  Priority: turn[1][2] if it matches an emitted candidate; else turn[3][3]; else first candidate. */
function extractSelectedCandidateId(turn: Turn, emittedIds: Set<string>): string | null {
  // turn[1] = [convId, respMsgId, rc_selectedChoiceId] | null
  const respRef = turn[1];
  if (Array.isArray(respRef) && typeof respRef[2] === "string" && emittedIds.has(respRef[2])) {
    return respRef[2];
  }
  // turn[3][3] = default candidate rc id
  const respData = turn[3];
  if (Array.isArray(respData)) {
    const defaultId = respData[3];
    if (typeof defaultId === "string" && emittedIds.has(defaultId)) return defaultId;
  }
  // Fallback: first emitted candidate.
  return emittedIds.size > 0 ? (emittedIds.values().next().value ?? null) : null;
}

interface MaybeEnvelope {
  payload?: unknown;
  title?: string | null;
  account?: string | null;
  source_id?: unknown;
  raw_url?: string | null;
  fetched_at?: string | null;
  conversation_updated_at?: string | null;
}

/** Parse a live Gemini capture (RawCapture envelope).
 *  Emits EVERY candidate in each turn as an assistant message (all with parent_id =
 *  that turn's user message id). Chains turns: each turn's user message parent_id =
 *  the PREVIOUS turn's selected assistant id. active_leaf_id = last turn's selected
 *  assistant id (or last user message id when no assistant was emitted for that turn). */
export function parseGemini(raw: unknown, context: ParserContext = {}): Session[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const env = raw as MaybeEnvelope;
  const account = typeof env.account === "string" ? env.account : null;

  // Source ID from the envelope (the 16-hex conversation id, no c_ prefix).
  const sourceId = typeof env.source_id === "string" ? env.source_id : null;
  if (!sourceId) return [];

  const payload = "payload" in env && env.payload != null ? env.payload : null;
  if (!Array.isArray(payload)) return [];

  // payload[0] = turns array
  const turnsRaw = payload[0];
  if (!Array.isArray(turnsRaw)) return [];
  const turns = turnsRaw as Turn[];

  const messages: Message[] = [];
  const assetLookup = assetLookupFromRaw(raw);
  const hasAsset = (id: string) => assetLookup.references().some(asset => asset.message_id === id);
  const loc = { raw_ref: context.raw_ref ?? `raw/api/gemini:${sourceId}`, raw_path: "/payload" };
  let firstTimestamp: string | null = null;
  let lastTimestamp: string | null = null;
  let defaultModel: string | null = null;
  // The selected assistant id from the previous turn; used to chain user messages.
  let prevSelectedAssistantId: string | null = null;
  // Tracks the last emitted "active tip" for active_leaf_id.
  let lastActiveTipId: string | null = null;

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (!Array.isArray(turn)) continue;

    const model = extractModel(turn);
    if (model && !defaultModel) defaultModel = model;

    // --- User message ---
    const at = childLocation(loc, 0, i);
    const userMeta = Array.isArray(turn[2]) ? turn[2] : [];
    const userBlocks = [...geminiTextParts(userMeta[0], childLocation(at, 2, 0)),
      ...geminiOpaqueSlots(userMeta, [0], childLocation(at, 2), "gemini.user")];
    const userMsgId = extractUserMsgId(turn);
    if (userMsgId) userBlocks.push(...capturedAssetBlocks(assetLookup, [userMsgId], userBlocks));
    if (userBlocks.length && userMsgId) {
      const userMsg: Message = {
        id: userMsgId,
        role: "user",
        created_at: null, // Gemini does not expose user-message timestamps in hNvQHb
        parent_id: prevSelectedAssistantId, // chained from previous turn's selected candidate
        model: null,
        blocks: userBlocks,
        text: renderText(userBlocks),
      };
      messages.push(userMsg);
      lastActiveTipId = userMsgId;
    }

    // --- Assistant messages: all candidates ---
    const candidates = geminiCandidates(turn, at, hasAsset);
    const emittedCandidateIds = new Set<string>(candidates.map((c) => c.id));
    const assistantTs = extractAssistantTimestamp(turn);
    const selectedId = extractSelectedCandidateId(turn, emittedCandidateIds);

    for (const cand of candidates) {
      const assistantBlocks = cand.blocks;
      assistantBlocks.push(...capturedAssetBlocks(assetLookup, [cand.id], assistantBlocks));
      if (cand.id === selectedId) {
        if (Array.isArray(turn[3])) assistantBlocks.push(...geminiOpaqueSlots(turn[3], [0, 3, 21], childLocation(at, 3), "gemini.response"));
        assistantBlocks.push(...geminiOpaqueSlots(turn, [0, 1, 2, 3, 4], at, "gemini.turn"));
      }
      const assistantMsg: Message = {
        id: cand.id,
        role: "assistant",
        created_at: assistantTs,
        parent_id: userMsgId ?? null, // all candidates share the same user message parent
        model,
        blocks: assistantBlocks,
        text: renderText(assistantBlocks),
      };
      messages.push(assistantMsg);
    }

    if (candidates.length > 0) {
      if (assistantTs) {
        if (!firstTimestamp) firstTimestamp = assistantTs;
        lastTimestamp = assistantTs;
      }
      // Advance chain to the selected candidate for the next turn.
      prevSelectedAssistantId = selectedId ?? candidates[0].id;
      lastActiveTipId = prevSelectedAssistantId;
    }
  }

  addCapturedAssets(messages, assetLookup, lastActiveTipId);

  // Fallback timestamps: use fetched_at from the envelope if no assistant timestamps.
  const fetchedAt =
    typeof env.fetched_at === "string" ? env.fetched_at : new Date(0).toISOString();
  const created = firstTimestamp ?? fetchedAt;
  const updated = lastTimestamp ?? fetchedAt;

  // Title: not present in hNvQHb payload; left null unless the envelope carries it.
  const title = typeof env.title === "string" ? env.title : null;
  const activeMessage = messages.find(m => m.id === lastActiveTipId);
  if (activeMessage) activeMessage.blocks.push(...geminiOpaqueSlots(payload, [0], loc, "gemini.payload"));

  const session: Session = {
    id: makeSessionId("gemini", sourceId),
    source: "gemini",
    source_id: sourceId,
    capture_method: "api",
    title,
    created_at: created,
    updated_at: updated,
    default_model: defaultModel,
    account,
    messages,
    active_leaf_id: lastActiveTipId,
    raw_ref: context.raw_ref ?? `raw/api/gemini:${sourceId}`,
    schema_version: SCHEMA_VERSION,
  };

  return [limitUnknownJson(session)];
}
