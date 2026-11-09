/** A declared length is peer-controlled, so it never sizes more than this up front; buffers grow as bytes arrive. */
export const INITIAL_BODY_BUFFER_BYTES = 16 * 1024 * 1024;

/** The first buffer for a body of `declared` bytes (0 when unknown). */
export function initialBodyBufferSize(declared: number): number {
  return Math.min(declared, INITIAL_BODY_BUFFER_BYTES);
}

/**
 * Next capacity once `total` bytes no longer fit. Growth is geometric from the bytes actually
 * received (an empty start allocates what arrived, then doubles, so a small undeclared body is
 * never over-allocated) and stops at the declared length while the body is within it, so an
 * honest body ends in a buffer of exactly its size. A missing or understated length grows to `limit`.
 */
export function nextBodyBufferSize(capacity: number, total: number, declared: number, limit: number): number {
  const ceiling = declared >= total ? Math.min(declared, limit) : limit;
  return Math.min(ceiling, Math.max(total, capacity * 2));
}
