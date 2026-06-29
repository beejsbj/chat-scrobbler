import type { ProviderSource, RawCapture, UploadedAsset } from "../../../shared/src";
import type { AssetUploadRequest } from "../messages";

export interface ProviderSyncOptions {
  lastSync?: string | null;
  emitCapture: (capture: RawCapture) => Promise<void>;
  shouldIgnore?: (source: ProviderSource, sourceId: string) => boolean;
  uploadAsset?: (asset: AssetUploadRequest) => Promise<UploadedAsset>;
}

export type ProviderCaptureOneOptions = Pick<ProviderSyncOptions, "emitCapture" | "uploadAsset">;

export interface ProviderSyncResult {
  source: ProviderSource;
  scanned: number;
  captured: number;
  skipped: number;
  maxConversationUpdatedAt: string | null;
  account: string | null;
}

export interface ProviderAdapter {
  source: ProviderSource;
  sync(options: ProviderSyncOptions): Promise<ProviderSyncResult>;
  /** List recent conversations (id + updatedAt) for sidebar badge reconciliation.
   *  `pages` caps pagination (default 1 = the most-recent page). */
  listConversations?(pages?: number): Promise<ConversationSummary[]>;
  /** Capture a single conversation by id (fetch detail + emit one RawCapture). */
  captureOne?(id: string, updatedAt: string | null, options: ProviderCaptureOneOptions): Promise<void>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ConversationSummary {
  id: string;
  updatedAt: string | null;
}

export class RateLimitError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;

  constructor(input: string, status: number, retryAfterMs: number | null) {
    super(`${input} failed with HTTP ${status}; retry later`);
    this.name = "RateLimitError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isRateLimitError(error: unknown): error is RateLimitError {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "RateLimitError";
}

export function parseRetryAfterMs(value: string | null, nowMs = Date.now()): number | null {
  const raw = value?.trim();
  if (!raw) return null;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);

  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - nowMs);

  return null;
}

export function shouldCapture(updatedAt: string | null, lastSync?: string | null): boolean {
  if (!lastSync || !updatedAt) return true;
  return Date.parse(updatedAt) > Date.parse(lastSync);
}

export function maxIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

export async function fetchJson(fetcher: FetchLike, input: string, init?: RequestInit): Promise<unknown> {
  const res = await fetcher(input, { credentials: "include", ...init });
  if (res.status === 429 || res.status === 503) {
    throw new RateLimitError(input, res.status, parseRetryAfterMs(res.headers.get("retry-after")));
  }
  if (!res.ok) throw new Error(`${input} failed with HTTP ${res.status}`);
  return res.json();
}

export function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
