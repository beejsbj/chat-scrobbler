import type { Source } from "../schema/types";
import { SOURCES } from "../store/raw-catalog";

export function providerFreshness(days: Record<Source, number | null>, receipts: Partial<Record<Source, string | null>>, parsed: Partial<Record<Source, string>>, stateAvailable: boolean) {
  const failures: string[] = [];
  const providers = Object.fromEntries(SOURCES.map(source => {
    const threshold = days[source];
    const last = receipts[source] ?? null;
    const success = parsed[source] ?? null;
    const isStale = (time: string | null) => threshold !== null && (!time || Date.now() - Date.parse(time) > threshold * 86_400_000);
    const stale = stateAvailable ? isStale(last) : null;
    const parsedStale = stateAvailable && success ? isStale(success) : null;
    if (stale) failures.push(`FAILED freshness.${source} ${last ? `stale threshold_days=${threshold}` : "no_captures"}`);
    if (parsedStale) failures.push(`FAILED freshness.parsed.${source} stale threshold_days=${threshold}`);
    return [source, { last_capture_at: last, last_parsed_at: success, threshold_days: threshold, stale, parsed_stale: parsedStale }];
  }));
  return { providers, failures };
}
