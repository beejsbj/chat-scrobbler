import { isRateLimitError, type ConversationSummary, type ProviderSyncOptions } from "./types";

/** Gap between detail fetches. Slow enough that a large catch-up stays under provider rate limits. */
export const pacing = { detailMs: 600 };
/** A longer Retry-After is not waited out in-pass: the pass aborts and the next one resumes. */
export const MAX_RETRY_AFTER_WAIT_MS = 30_000;

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Spaces detail fetches and honors a short Retry-After once before giving up. */
export class DetailPacer {
  private started = false;
  constructor(private options: Pick<ProviderSyncOptions, "pace" | "sleep">) {}

  async fetch<T>(run: () => Promise<T>): Promise<T> {
    if (this.started) await (this.options.pace ?? (() => delay(pacing.detailMs)))();
    this.started = true;
    try { return await run(); }
    catch (error) {
      if (!isRateLimitError(error) || error.retryAfterMs === null || error.retryAfterMs > MAX_RETRY_AFTER_WAIT_MS) throw error;
      await (this.options.sleep ?? delay)(error.retryAfterMs);
      return run();
    }
  }
}

/**
 * Ids the receiver already holds at the listed update time. Progress of an aborted pass lives
 * on the receiver (a capture is acknowledged only once indexed), so the next pass skips these
 * without a detail fetch. Fails open: if the receiver cannot answer, everything is fetched.
 */
export async function receiverSyncedIds(options: Pick<ProviderSyncOptions, "getStatuses">, items: ConversationSummary[]): Promise<Set<string>> {
  if (!options.getStatuses || items.length === 0) return new Set();
  try {
    const statuses = await options.getStatuses(items);
    return new Set(items.filter(item => statuses[item.id] === "synced").map(item => item.id));
  } catch { return new Set(); }
}
