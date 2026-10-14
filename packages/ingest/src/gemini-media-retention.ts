import { join } from "node:path";
import type { RawCapture } from "../../shared/src";
import { readRawCapture, storeRawCapture } from "../../../src/store/raw";
import { latestRaw, rawContentHash } from "../../../src/store/raw-latest";
import { encodedSegment } from "../../../src/store/tombstones";

const key = (asset: { pointer: string; message_id?: string | null }) => JSON.stringify([asset.message_id ?? null, asset.pointer]);
const payloadHash = (capture: RawCapture) => rawContentHash({ ...capture, assets: [], asset_references: [] });

/** Preserve off-page Gemini media without borrowing bytes across payload revisions.
 * Archive the exact incoming capture first, then its enriched projection source.
 */
export function archiveCaptureWithGeminiMedia(rawDir: string, incoming: RawCapture, serialized: string): { capture: RawCapture; rawRef: string } {
  let previous: RawCapture | null = null;
  if (incoming.source === "gemini") {
    const dir = join("gemini", encodedSegment(incoming.source_id));
    const latest = latestRaw(join(rawDir, dir));
    if (latest) previous = readRawCapture(rawDir, join(dir, latest.file));
  }
  const rawRef = storeRawCapture(rawDir, incoming, serialized);
  if (!previous || previous.source_id !== incoming.source_id || (previous.account ?? null) !== (incoming.account ?? null)
    || payloadHash(previous) !== payloadHash(incoming)) return { capture: incoming, rawRef };

  // Malformed asset lists still go through the existing parser/error boundary.
  for (const capture of [incoming, previous]) {
    if ((capture.assets !== undefined && !Array.isArray(capture.assets))
      || (capture.asset_references !== undefined && !Array.isArray(capture.asset_references))) return { capture: incoming, rawRef };
  }
  const observed = new Set([...(incoming.assets ?? []), ...(incoming.asset_references ?? [])].map(key));
  // An observed pointer that failed to download must not reuse possibly stale bytes.
  const keptAssets = (previous.assets ?? []).filter(asset => !observed.has(key(asset)));
  const keptReferences = (previous.asset_references ?? []).filter(asset => !observed.has(key(asset)));
  if (!keptAssets.length && !keptReferences.length) return { capture: incoming, rawRef };
  const capture = { ...incoming, assets: [...(incoming.assets ?? []), ...keptAssets],
    asset_references: [...(incoming.asset_references ?? []), ...keptReferences] };
  return { capture, rawRef: storeRawCapture(rawDir, capture) };
}
