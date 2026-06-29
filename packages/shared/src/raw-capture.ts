export type ProviderSource = "chatgpt" | "claude" | "gemini";
export type ApiCaptureMethod = "api";

export const RAW_CAPTURE_SCHEMA_VERSION = 1;

export interface RawCapture<TPayload = unknown> {
  source: ProviderSource;
  capture_method: ApiCaptureMethod;
  schema_version: typeof RAW_CAPTURE_SCHEMA_VERSION;
  fetched_at: string;
  source_id: string;
  endpoint: string;
  payload: TPayload;
  account?: string | null;
  conversation_updated_at?: string | null;
  cursor?: string | null;
  raw_url?: string | null;
  assets?: UploadedAsset[];
}

export interface UploadedAsset {
  pointer: string;
  local_path: string;
  message_id?: string | null;
  filename?: string | null;
  content_type?: string | null;
  size_bytes?: number | null;
  sha256?: string | null;
}

export interface BuildRawCaptureInput<TPayload = unknown> {
  source: ProviderSource;
  sourceId: string;
  endpoint: string;
  payload: TPayload;
  fetchedAt?: string;
  account?: string | null;
  conversationUpdatedAt?: string | null;
  cursor?: string | null;
  rawUrl?: string | null;
  assets?: UploadedAsset[];
}

export function buildRawCapture<TPayload>(input: BuildRawCaptureInput<TPayload>): RawCapture<TPayload> {
  return {
    source: input.source,
    capture_method: "api",
    schema_version: RAW_CAPTURE_SCHEMA_VERSION,
    fetched_at: input.fetchedAt ?? new Date().toISOString(),
    source_id: input.sourceId,
    endpoint: input.endpoint,
    payload: input.payload,
    account: input.account ?? null,
    conversation_updated_at: input.conversationUpdatedAt ?? null,
    cursor: input.cursor ?? null,
    raw_url: input.rawUrl ?? null,
    assets: input.assets ?? [],
  };
}

export function assertRawCapture(value: unknown): asserts value is RawCapture {
  if (!isObject(value)) throw new Error("Raw capture must be an object");
  if (!isProviderSource(value.source)) throw new Error("Raw capture source is invalid");
  if (value.capture_method !== "api") throw new Error("Raw capture method must be api");
  if (value.schema_version !== RAW_CAPTURE_SCHEMA_VERSION) throw new Error("Raw capture schema version is invalid");
  if (typeof value.fetched_at !== "string" || !isIsoDate(value.fetched_at)) {
    throw new Error("Raw capture fetched_at must be an ISO timestamp");
  }
  if (typeof value.source_id !== "string" || value.source_id.trim() === "") {
    throw new Error("Raw capture source_id is required");
  }
  if (typeof value.endpoint !== "string" || value.endpoint.trim() === "") {
    throw new Error("Raw capture endpoint is required");
  }
  if (!("payload" in value)) throw new Error("Raw capture payload is required");
}

export function isRawCapture(value: unknown): value is RawCapture {
  try {
    assertRawCapture(value);
    return true;
  } catch {
    return false;
  }
}

export function toCaptureArray(value: unknown): RawCapture[] {
  const captures = Array.isArray(value) ? value : [value];
  captures.forEach(assertRawCapture);
  return captures;
}

export function captureStorageName(capture: RawCapture): string {
  const fetched = capture.fetched_at.replace(/[:.]/g, "-");
  return `${sanitizePathSegment(capture.source_id)}-${fetched}.json`;
}

export function sanitizePathSegment(value: string): string {
  const sanitized = value
    .replace(/\.\.+/g, "_")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "");
  return sanitized || "unknown";
}

function isProviderSource(value: unknown): value is ProviderSource {
  return value === "chatgpt" || value === "claude" || value === "gemini";
}

function isIsoDate(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
