export class BodyTooLargeError extends Error {
  constructor(readonly limit: number) { super(`asset exceeds ${limit} byte limit`); }
}

/** Read a request body, cancelling the stream as soon as it exceeds `limit` (regardless of content-length). */
export async function readBoundedBody(req: Request, limit: number): Promise<Uint8Array> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await req.body?.cancel().catch(() => {});
    throw new BodyTooLargeError(limit);
  }
  if (!req.body) return new Uint8Array(0);
  return collectBounded(req.body.getReader(), limit, Number.isFinite(declared) && declared > 0 ? declared : 0);
}

/**
 * With a declared length the bytes land in one buffer, not a chunk list plus a concatenated copy,
 * which halves peak memory for large assets. A body that outruns its declared length grows the buffer.
 */
export async function collectBounded(reader: ReadableStreamDefaultReader<Uint8Array>, limit: number, declared = 0): Promise<Uint8Array> {
  let buffer = new Uint8Array(declared);
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLargeError(limit);
    }
    if (total > buffer.byteLength) {
      const grown = new Uint8Array(Math.min(limit, Math.max(total, buffer.byteLength * 2)));
      grown.set(buffer.subarray(0, total - value.byteLength));
      buffer = grown;
    }
    buffer.set(value, total - value.byteLength);
  }
  return buffer.byteLength === total ? buffer : buffer.slice(0, total);
}
