import type { ProviderSource } from "./raw-capture";

// 4318: the prior default :4319 collided with an unrelated local server. Keep
// this free of common dev-server ports so the prefilled popup URL "just works".
export const DEFAULT_INGEST_BASE_URL = "http://127.0.0.1:4318";
export const CAPTURE_INGEST_PATH = "/captures";
export const ASSET_INGEST_PATH = "/assets";
export const STATUS_PATH = "/status";
export const HEALTH_PATH = "/health";
export const DEFAULT_SYNC_PERIOD_MINUTES = 30;
/**
 * Per-asset size limit for the extension and the receiver. 512 MiB is ChatGPT's own per-file cap;
 * assets are buffered in memory on both sides, so this is also the ceiling that stays survivable.
 */
export const DEFAULT_MAX_ASSET_BYTES = 512 * 1024 * 1024;
/** The default before 512 MiB. Popup saves persisted it, so an extension limit equal to it is read as "never chosen". */
export const LEGACY_MAX_ASSET_BYTES = 100 * 1024 * 1024;

export function statusUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${STATUS_PATH}`;
}

export function capturesUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${CAPTURE_INGEST_PATH}`;
}

export function deleteCaptureUrl(baseUrl: string, source: ProviderSource, sourceId: string): string {
  const url = new URL(capturesUrl(baseUrl));
  url.searchParams.set("source", source);
  url.searchParams.set("source_id", sourceId);
  return url.toString();
}

export function assetsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${ASSET_INGEST_PATH}`;
}

export function healthUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${HEALTH_PATH}`;
}
