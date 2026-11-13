import { BACKFILL_MAX_ASSETS, BACKFILL_MAX_BODY_BYTES, type AssetBackfillCommit, type AssetBackfillPage, type UploadedAsset } from "../../shared/src";
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

/** Keeps each commit under the receiver's asset count and body size limits (a lone oversized asset still goes alone). */
function* chunkAssets(sourceId: string, source: string, assets: UploadedAsset[]): Generator<UploadedAsset[]> {
  const budget = BACKFILL_MAX_BODY_BYTES - 1024 - new TextEncoder().encode(JSON.stringify({ source, source_id: sourceId, assets: [] })).length;
  let chunk: UploadedAsset[] = [], bytes = 0;
  for (const asset of assets) {
    const size = new TextEncoder().encode(JSON.stringify(asset)).length + 1;
    if (chunk.length && (chunk.length >= BACKFILL_MAX_ASSETS || bytes + size > budget)) { yield chunk; chunk = []; bytes = 0; }
    chunk.push(asset);
    bytes += size;
  }
  if (chunk.length) yield chunk;
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
    // Chunks commit in order and a failed one throws, so the page never advances past an unsaved chunk.
    // Re-linking an already-linked asset is idempotent on the receiver, so a retried session is safe.
    for (const chunk of chunkAssets(session.source_id, provider.source, assets)) {
      assertBackfillReceipt(await options.commit({ source: provider.source, source_id: session.source_id, assets: chunk }), chunk.length);
    }
    attempted += session.references.length;
    captured += assets.length;
    unavailable += session.references.length - assets.length;
  }
  return { sessions, attempted, captured, unavailable, next_after: page.next_after };
}
