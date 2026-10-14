import type { AssetBackfillCommit, AssetBackfillPage } from "../../shared/src";
import type { ProviderAdapter, ProviderSyncOptions } from "./providers/types";

interface BackfillOptions {
  uploadAsset: ProviderSyncOptions["uploadAsset"];
  commit: (value: AssetBackfillCommit) => Promise<void>;
  shouldIgnore?: (id: string) => boolean;
  pause?: (ms: number) => Promise<void>;
}

/** A bounded page per click; the background persists next_after so later clicks resume. */
export async function backfillProviderAssets(provider: ProviderAdapter, page: AssetBackfillPage, options: BackfillOptions) {
  if (!provider.backfillAssets) throw new Error("Provider asset backfill is unavailable");
  let sessions = 0, attempted = 0, captured = 0, unavailable = 0;
  const pause = options.pause ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  for (const session of page.sessions) {
    if (options.shouldIgnore?.(session.source_id)) continue;
    sessions++;
    const assets = await provider.backfillAssets(session.source_id, session.references, {
      uploadAsset: options.uploadAsset, beforeFetch: () => pause(1000),
    });
    if (assets.length) await options.commit({ source: provider.source, source_id: session.source_id, assets });
    attempted += session.references.length;
    captured += assets.length;
    unavailable += session.references.length - assets.length;
  }
  return { sessions, attempted, captured, unavailable, next_after: page.next_after };
}
