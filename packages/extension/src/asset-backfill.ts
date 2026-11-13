import type { AssetBackfillCommit, AssetBackfillPage } from "../../shared/src";
import type { ProviderAdapter, ProviderSyncOptions } from "./providers/types";

interface BackfillOptions {
  uploadAsset: ProviderSyncOptions["uploadAsset"];
  /** Resolves with the receiver's receipt; it is checked before the assets count as captured. */
  commit: (value: AssetBackfillCommit) => Promise<unknown>;
  shouldIgnore?: (id: string) => boolean;
  pause?: (ms: number) => Promise<void>;
}

/**
 * The receiver answers a commit with `{ ok: true, linked, raw_ref }`, `linked` being the number of
 * distinct references it linked and `raw_ref` the enriched raw version (null for legacy sessions
 * without a raw capture). Anything else, such as a proxy's bare `{ ok: true }`, is not an acknowledgement.
 */
function assertBackfillReceipt(receipt: unknown, committed: number) {
  const r = receipt as { ok?: unknown; linked?: unknown; raw_ref?: unknown } | null | undefined;
  const valid = !!r && typeof r === "object" && r.ok === true && r.linked === committed
    && (r.raw_ref === null || (typeof r.raw_ref === "string" && r.raw_ref !== ""));
  if (!valid) throw new Error("Backfill commit acknowledgement does not match the committed assets");
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
    if (assets.length) assertBackfillReceipt(await options.commit({ source: provider.source, source_id: session.source_id, assets }), assets.length);
    attempted += session.references.length;
    captured += assets.length;
    unavailable += session.references.length - assets.length;
  }
  return { sessions, attempted, captured, unavailable, next_after: page.next_after };
}
