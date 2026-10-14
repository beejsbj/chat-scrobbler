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
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLargeError(limit);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}
