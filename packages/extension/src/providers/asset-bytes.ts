/** Bound the body while reading, including chunked responses without Content-Length. */
export async function boundedAssetBytes(res: Response, maxBytes: number): Promise<number[]> {
  const length = Number(res.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    await res.body?.cancel();
    throw new Error("asset_too_large");
  }
  if (!res.body) return [];
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
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return Array.from(bytes);
}
