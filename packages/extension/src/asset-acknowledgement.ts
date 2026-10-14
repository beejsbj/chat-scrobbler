import type { UploadedAsset } from "../../shared/src";

interface Expected { pointer: string; sha256: string; sizeBytes?: number; }

/** Fail closed: a receiver reply only counts when it echoes exactly what we sent. */
export function validateAssetAcknowledgement(body: unknown, expected: Expected): UploadedAsset {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid();
  const ack = body as Record<string, unknown>;
  if (ack.ok !== true || ack.pointer !== expected.pointer || ack.sha256 !== expected.sha256) throw invalid();
  if (!safeAssetPath(ack.local_path)) throw invalid();
  const size = ack.size_bytes;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) throw invalid();
  if (expected.sizeBytes !== undefined && size !== expected.sizeBytes) throw invalid();
  return { ...ack, pointer: expected.pointer, local_path: ack.local_path, sha256: expected.sha256, size_bytes: size } as UploadedAsset;
}

/** Size reported by `GET /assets?sha256=`, when the receiver provides one. */
export function lookupSize(body: unknown): number | undefined {
  const size = (body as { size_bytes?: unknown } | null)?.size_bytes;
  return typeof size === "number" && Number.isSafeInteger(size) && size >= 0 ? size : undefined;
}

function safeAssetPath(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("assets/") || value.includes("\\") || value.includes("\0")) return false;
  return value.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

function invalid(): Error { return new Error("asset_ack_invalid"); }
