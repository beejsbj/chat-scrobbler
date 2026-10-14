import type { ProviderAdapter, ProviderSyncOptions } from "./providers/types";
import { SyncFailureTracker } from "./providers/sync-failures";
import { DetailFailureStreak } from "./providers/detail-failure-streak";

interface RetryOptions extends ProviderSyncOptions { pause?: () => Promise<void>; }
export async function retryCapturedFailures(provider: ProviderAdapter, options: RetryOptions) {
  const failures = new SyncFailureTracker(options.captureFailures);
  const detailFailures = new DetailFailureStreak(options.detailFailureStreak);
  let captured = 0, failed = 0, skipped = 0;
  try {
  for (const previous of options.captureFailures ?? []) {
    if (options.shouldIgnore?.(provider.source, previous.source_id)) { failures.succeeded(previous.source_id); skipped++; continue; }
    await (options.pause ?? (() => new Promise(resolve => setTimeout(resolve, 1000))))();
    try {
      if (!provider.captureOne) throw new Error("Single capture unavailable");
      await provider.captureOne(previous.source_id, previous.updated_at, options);
      detailFailures.succeeded(previous.source_id);
      failures.succeeded(previous.source_id);
      captured++;
    } catch (error) { detailFailures.failed(error, previous.source_id, previous.updated_at); failed++; failures.failed(previous.source_id, previous.updated_at, error); }
  }
  detailFailures.finish();
  return { source: provider.source, scanned: options.captureFailures?.length ?? 0, captured, failed, skipped,
    captureFailures: failures.list(), detailFailureStreak: detailFailures.snapshot(), maxConversationUpdatedAt: options.lastSync ?? null, account: null };
  } catch (error) { return failures.abort(error); }
}
