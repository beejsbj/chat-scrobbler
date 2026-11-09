import { initialBodyBufferSize, nextBodyBufferSize } from "../../shared/src/body-buffer";

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
 * Bytes land in one growing buffer, not a chunk list plus a concatenated copy. The declared length
 * only caps growth (see nextBodyBufferSize), never sizes an up-front allocation: a client that
 * declares 512 MiB and sends little costs only what it sent.
 */
export async function collectBounded(reader: ReadableStreamDefaultReader<Uint8Array>, limit: number, declared = 0): Promise<Uint8Array> {
  let buffer = new Uint8Array(initialBodyBufferSize(declared));
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
      const grown = new Uint8Array(nextBodyBufferSize(buffer.byteLength, total, declared, limit));
      grown.set(buffer.subarray(0, total - value.byteLength));
      buffer = grown;
    }
    buffer.set(value, total - value.byteLength);
  }
  return buffer.byteLength === total ? buffer : buffer.slice(0, total);
}
