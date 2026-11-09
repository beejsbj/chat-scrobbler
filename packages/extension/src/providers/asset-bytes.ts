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
  // Bytes land in one growing buffer instead of a chunk list plus a concatenated copy. The declared
  // length is only a growth ceiling: a server that declares a huge body and sends little costs little.
  const declared = Number.isFinite(length) && length > 0 ? length : 0;
  let bytes = new Uint8Array(Math.min(declared, 16 * 1024 * 1024));
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
      if (total > bytes.byteLength) {
        const ceiling = Math.min(maxBytes, Math.max(declared, total));
        const grown = new Uint8Array(Math.min(ceiling, Math.max(total, bytes.byteLength * 2)));
        grown.set(bytes.subarray(0, total - value.byteLength));
        bytes = grown;
      }
      bytes.set(value, total - value.byteLength);
    }
  } catch (error) {
    if ((error as Error)?.message === "asset_too_large") throw error;
    throw new TransientSyncError("Provider asset stream interrupted");
  } finally { reader.releaseLock(); }
  return bytes.byteLength === total ? bytes : bytes.slice(0, total);
}

export async function boundedAssetBytes(res: Response, maxBytes: number): Promise<number[]> {
  return Array.from(await boundedAssetBuffer(res, maxBytes));
}
