import type { ChatHistoryConfig } from "../config";
import { unknownTypes } from "../core/unknown-types";

export function runUnknownTypesCmd(opts: { cfg: ChatHistoryConfig; source?: string; json?: boolean; write: (text: string) => void }) {
  const report = unknownTypes(opts.cfg.canonicalDir, opts.source);
  if (opts.json) opts.write(JSON.stringify(report, null, 2));
  else {
    for (const row of report.counts) opts.write(`${row.source}: ${row.provider_type} = ${row.count}`);
    opts.write(`${report.counts.reduce((sum, row) => sum + row.count, 0)} unknown block(s) in ${report.scanned_sessions} session(s); ${report.unreadable_sessions} unreadable.`);
  }
  return report;
}
