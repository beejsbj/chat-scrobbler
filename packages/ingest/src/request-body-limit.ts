/** Bun's former default transport cap; raw captures are bounded by this, independent of the asset limit. */
export const MIN_INGEST_REQUEST_BODY_BYTES = 128 * 1024 * 1024;

/** Transport cap for Bun.serve. POST /assets enforces its own maxAssetBytes inside the handler. */
export function ingestMaxRequestBodySize(maxAssetBytes: number): number {
  return Math.max(maxAssetBytes, MIN_INGEST_REQUEST_BODY_BYTES);
}
