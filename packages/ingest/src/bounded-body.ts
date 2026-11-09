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

/** A declared length is client-controlled, so it never sizes more than this up front; the buffer grows as bytes arrive. */
export const INITIAL_BODY_BUFFER_BYTES = 16 * 1024 * 1024;

/**
 * Bytes land in one growing buffer, not a chunk list plus a concatenated copy. The declared length
 * is a ceiling for growth (so an honest body ends exactly full), never an up-front allocation: a
 * client that declares 512 MiB and sends little costs only what it sent.
 */
export async function collectBounded(reader: ReadableStreamDefaultReader<Uint8Array>, limit: number, declared = 0): Promise<Uint8Array> {
  let buffer = new Uint8Array(Math.min(declared, INITIAL_BODY_BUFFER_BYTES));
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
      // Growth is geometric (floor: the initial size, so an empty start still doubles) and stops at the
      // declared length while the body is still within it; a missing or understated length grows to the limit.
      const ceiling = declared > total ? Math.min(declared, limit) : limit;
      const grown = new Uint8Array(Math.min(ceiling, Math.max(total, buffer.byteLength * 2, INITIAL_BODY_BUFFER_BYTES)));
      grown.set(buffer.subarray(0, total - value.byteLength));
      buffer = grown;
    }
    buffer.set(value, total - value.byteLength);
  }
  return buffer.byteLength === total ? buffer : buffer.slice(0, total);
}
