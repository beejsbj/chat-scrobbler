// src/core/session-id.ts
// Parses and validates the canonical "source:source_id" session id format.
// Used by the MCP server and CLI to avoid duplicating the same regexes.

const VALID_SOURCE = /^(chatgpt|claude|gemini)$/;
const VALID_SOURCE_ID = /^[A-Za-z0-9_-]+$/;

export type ParseSessionIdResult =
  | { ok: true; source: string; sourceId: string }
  | { ok: false; error: string };

/**
 * Parses a session id of the form "source:source_id".
 *
 * Returns { ok: true, source, sourceId } on success, or
 * { ok: false, error } with a human-readable reason on failure.
 */
export function parseSessionId(id: string): ParseSessionIdResult {
  const idx = id.indexOf(":");
  if (idx <= 0) {
    return { ok: false, error: `Invalid session id "${id}": expected format "source:source_id"` };
  }
  const source = id.slice(0, idx);
  const sourceId = id.slice(idx + 1);
  if (!VALID_SOURCE.test(source)) {
    return { ok: false, error: `Invalid session id "${id}": unknown source "${source}"` };
  }
  if (!VALID_SOURCE_ID.test(sourceId)) {
    return { ok: false, error: `Invalid session id "${id}": unsafe source_id "${sourceId}"` };
  }
  return { ok: true, source, sourceId };
}
