import { readFileSync } from "node:fs";
import type { Session, Source } from "../schema/types";
import { listSessionFiles } from "../store/sessions";
import { SOURCES } from "../store/raw-catalog";

export interface UnknownTypeReport {
  scanned_sessions: number; unreadable_sessions: number;
  counts: Array<{ source: Source; provider_type: string; count: number }>;
}

/** Count all branches in canonical, including size-capped blocks. Never expose fragments. */
export function unknownTypes(canonicalDir: string, source?: string): UnknownTypeReport {
  if (source && !SOURCES.includes(source as Source)) throw new Error("source must be chatgpt, claude or gemini");
  const report: UnknownTypeReport = { scanned_sessions: 0, unreadable_sessions: 0, counts: [] };
  const counts = new Map<string, Map<string, number>>();
  for (const file of listSessionFiles(canonicalDir)) {
    try {
      const session = JSON.parse(readFileSync(file, "utf8")) as Session;
      if (source && session.source !== source) continue;
      if (!SOURCES.includes(session.source) || !Array.isArray(session.messages)) throw new Error("invalid session");
      const types = new Map<string, number>();
      for (const message of session.messages) {
        for (const block of message.blocks) {
          if (block.type === "unknown") {
            if (typeof block.provider_type !== "string") throw new Error("invalid unknown type");
            types.set(block.provider_type, (types.get(block.provider_type) ?? 0) + 1);
          }
        }
      }
      const totals = counts.get(session.source) ?? new Map<string, number>();
      for (const [type, count] of types) totals.set(type, (totals.get(type) ?? 0) + count);
      counts.set(session.source, totals);
      report.scanned_sessions++;
    } catch { report.unreadable_sessions++; }
  }
  for (const [provider, types] of counts) for (const [provider_type, count] of types) {
    report.counts.push({ source: provider as Source, provider_type, count });
  }
  report.counts.sort((a, b) => a.source.localeCompare(b.source) || a.provider_type.localeCompare(b.provider_type));
  return report;
}
