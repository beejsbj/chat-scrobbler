import { existsSync } from "node:fs";
import { listRawSessions, SOURCES } from "../store/raw-catalog";
import { listRawCaptures, readRawCapture } from "../store/raw";
import { sessionFilePath } from "../store/sessions";
import { isSessionDeleted } from "../store/tombstones";
import { getParser } from "../parsers/registry";
import type { Source } from "../schema/types";

/** Raw fetched_at is a capture date, unlike conversation updated_at. */
export function rawObservations(rawDir: string, canonicalDir: string) {
  const lastCapture: Record<Source, string | null> = { chatgpt: null, claude: null, gemini: null };
  let parseFailures = 0, unprojected = 0, unreadable = 0;
  for (const identity of listRawSessions(rawDir)) {
    if (isSessionDeleted(canonicalDir, identity.source, identity.source_id)) continue;
    const hasCanonical = existsSync(sessionFilePath(canonicalDir, identity.source, identity.source_id));
    for (const ref of listRawCaptures(rawDir, identity.source, identity.source_id)) {
      let capture;
      try {
        capture = readRawCapture(rawDir, ref);
        if (!SOURCES.includes(capture.source) || capture.source !== identity.source) throw new Error("invalid capture");
        const time = Date.parse(capture.fetched_at);
        if (!Number.isFinite(time) || time > Date.now() + 60_000) throw new Error("invalid capture date");
        const date = new Date(time).toISOString();
        if (!lastCapture[identity.source] || date > lastCapture[identity.source]!) lastCapture[identity.source] = date;
      } catch { unreadable++; continue; }
      if (!hasCanonical) {
        try {
          const sessions = getParser(capture.source, capture.capture_method)(capture, { raw_ref: ref });
          if (!sessions.length) parseFailures++;
          else unprojected++;
        } catch { parseFailures++; }
      }
    }
  }
  return { lastCapture, parseFailures, unprojected, unreadable };
}
