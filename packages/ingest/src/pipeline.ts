// packages/ingest/src/pipeline.ts
// "Fat server": fold a raw API capture straight into the spine — parse it with
// the matching *_api parser, write the canonical session, and index it — so a
// captured conversation is queryable immediately, per-conversation, without a
// full `unify` rebuild.
import type { Database } from "bun:sqlite";
import type { RawCapture } from "../../shared/src";
import { getParser } from "../../../src/parsers/registry";
import { writeSession } from "../../../src/store/sessions";
import { indexSession } from "../../../src/indexer/sqlite";

export interface SpineResult {
  session_id: string;
  source: string;
  source_id: string;
  indexed: boolean;
}

export interface SpineContext {
  canonicalDir: string;
  db: Database;
}

/** Parse one capture via (source, "api") and persist every session it yields.
 *  Returns one result per canonical session produced (usually exactly one). */
export function foldCaptureIntoSpine(capture: RawCapture, ctx: SpineContext): SpineResult[] {
  const parse = getParser(capture.source, "api");
  const sessions = parse(capture);
  return sessions.map((session) => {
    writeSession(ctx.canonicalDir, session);
    indexSession(ctx.db, session);
    return { session_id: session.id, source: session.source, source_id: session.source_id, indexed: true };
  });
}
