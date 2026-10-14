// packages/ingest/src/pipeline.ts
// "Fat server": fold a raw API capture straight into the spine — parse it with
// the matching *_api parser, write the canonical session, and index it — so a
// captured conversation is queryable immediately, per-conversation, without a
// full `unify` rebuild.
import type { Database } from "bun:sqlite";
import type { RawCapture } from "../../shared/src";
import { getParser } from "../../../src/parsers/registry";
import { writeSession } from "../../../src/store/sessions";
import { indexSession, type EmbeddingProvider } from "../../../src/indexer/sqlite";

export interface SpineResult {
  session_id: string;
  source: string;
  source_id: string;
  /** Canonical and FTS are ready. This does not assert model vector coverage. */
  indexed: boolean;
}

export interface SpineContext {
  canonicalDir: string;
  db: Database;
  rawRef?: string;
  onParse?: (success: boolean) => void;
  /** Compatibility option. Capture folding never runs inference. */
  embeddingProvider?: EmbeddingProvider | null;
}

/** Parse one capture via (source, "api") and persist every session it yields.
 *  Returns one result per canonical session produced (usually exactly one). */
export function foldCaptureIntoSpine(capture: RawCapture, ctx: SpineContext): SpineResult[] {
  const sessions = parseCapture(capture, ctx);
  return sessions.map((session) => {
    if (ctx.rawRef) session.raw_ref = ctx.rawRef;
    writeSession(ctx.canonicalDir, session);
    // Persist canonical and FTS immediately; missing vectors remain pending for backfill.
    indexSession(ctx.db, session, { canonicalDir: ctx.canonicalDir });
    return { session_id: session.id, source: session.source, source_id: session.source_id, indexed: true };
  });
}

/** Compatibility entrypoint. All DB work completes synchronously before this
 * promise resolves, so callers can close their DB after awaiting the fold.
 * Vector inference is deferred to explicit backfill, even with a provider. */
export async function foldCaptureIntoSpineWithEmbeddings(capture: RawCapture, ctx: SpineContext): Promise<SpineResult[]> {
  return foldCaptureIntoSpine(capture, ctx);
}

function parseCapture(capture: RawCapture, ctx: SpineContext) {
  let sessions;
  try {
    sessions = getParser(capture.source, "api")(capture, { raw_ref: ctx.rawRef });
    if (!sessions.length) throw new Error("capture_parse_empty");
  } catch (error) { ctx.onParse?.(false); throw error; }
  ctx.onParse?.(true);
  return sessions;
}
