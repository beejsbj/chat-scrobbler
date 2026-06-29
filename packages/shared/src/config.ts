import type { ProviderSource } from "./raw-capture";

// 4318: the prior default :4319 collided with an unrelated local server. Keep
// this free of common dev-server ports so the prefilled popup URL "just works".
export const DEFAULT_INGEST_BASE_URL = "http://127.0.0.1:4318";
export const CAPTURE_INGEST_PATH = "/captures";
export const ASSET_INGEST_PATH = "/assets";
export const STATUS_PATH = "/status";
export const HEALTH_PATH = "/health";
export const DEFAULT_SYNC_PERIOD_MINUTES = 30;

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
