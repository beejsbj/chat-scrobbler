import { TransientSyncError } from "./sync-errors";

/** Bound the body while reading, including chunked responses without Content-Length. */
export async function boundedAssetBuffer(res: Response, maxBytes: number): Promise<Uint8Array> {
  const length = Number(res.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    await res.body?.cancel();
    throw new Error("asset_too_large");
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("asset_too_large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if ((error as Error)?.message === "asset_too_large") throw error;
    throw new TransientSyncError("Provider asset stream interrupted");
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function boundedAssetBytes(res: Response, maxBytes: number): Promise<number[]> {
  return Array.from(await boundedAssetBuffer(res, maxBytes));
}
