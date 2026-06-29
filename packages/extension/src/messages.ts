import type { ProviderSource, RawCapture } from "../../shared/src";
import type { ProviderSyncResult } from "./providers";
import type { CaptureKind } from "./recent-captures";

export interface SyncRequest {
  type: "SCROBBLER_SYNC_REQUEST";
  provider: ProviderSource;
  lastSync?: string | null;
}

export interface CaptureReadyMessage {
  type: "SCROBBLER_CAPTURE_READY";
  capture: RawCapture;
}

export interface AssetUploadRequest {
  source: ProviderSource;
  sourceId: string;
  pointer: string;
  filename?: string | null;
  contentType?: string | null;
  bytes: number[];
}

export interface AssetUploadMessage {
  type: "SCROBBLER_ASSET_UPLOAD";
  asset: AssetUploadRequest;
}

export interface ProviderReadyMessage {
  type: "SCROBBLER_PROVIDER_READY";
  provider: ProviderSource;
}

export interface SyncActiveTabMessage {
  type: "SCROBBLER_SYNC_ACTIVE_TAB";
}

export interface SyncAllMessage {
  type: "SCROBBLER_SYNC_ALL_OPEN_TABS";
}

export interface GetStatusMessage {
  type: "SCROBBLER_GET_STATUS";
}

export interface SaveSettingsMessage {
  type: "SCROBBLER_SAVE_SETTINGS";
  ingestBaseUrl: string;
  /** Optional bearer token to pass to the ingest receiver. Empty string means no auth. */
  ingestToken?: string | null;
  /** When true, opening a provider tab auto-captures not-yet-synced conversations. */
  autoSync?: boolean;
}

/** Content -> background: resolve spine state for the sidebar's visible chats.
 *  Background forwards to the ingest /status endpoint (the cross-origin POST a
 *  page content script cannot make under provider CSP). */
export interface ConversationStatesMessage {
  type: "SCROBBLER_CONVERSATION_STATES";
  provider: ProviderSource;
  conversations: Array<{ id: string; updatedAt: string | null }>;
}

export interface CaptureProgressMessage {
  type: "SCROBBLER_CAPTURE_PROGRESS";
  remaining: number;
  total: number;
}

export interface IgnoredChatsMessage {
  type: "SCROBBLER_IGNORED_CHATS";
  provider: ProviderSource;
}

export interface ToggleIgnoredChatMessage {
  type: "SCROBBLER_TOGGLE_IGNORED_CHAT";
  provider: ProviderSource;
  id: string;
}

export interface DeleteCaptureMessage {
  type: "SCROBBLER_DELETE_CAPTURE";
  provider: ProviderSource;
  id: string;
}

export interface SnapshotCredentialsMessage {
  type: "SCROBBLER_SNAPSHOT_CREDENTIALS";
  provider: ProviderSource;
}

/** Sidebar -> background: a capture completed successfully; record it in the
 *  recent-captures buffer so the popup can show "captured this session". */
export interface CaptureLoggedMessage {
  type: "SCROBBLER_CAPTURE_LOGGED";
  id: string;
  title: string;
  capturedAt: string;
  kind: CaptureKind;
}

export type RuntimeMessage =
  | SyncRequest
  | CaptureReadyMessage
  | AssetUploadMessage
  | ProviderReadyMessage
  | SyncActiveTabMessage
  | SyncAllMessage
  | GetStatusMessage
  | SaveSettingsMessage
  | SnapshotCredentialsMessage
  | ConversationStatesMessage
  | CaptureProgressMessage
  | IgnoredChatsMessage
  | ToggleIgnoredChatMessage
  | DeleteCaptureMessage
  | CaptureLoggedMessage;

export interface ConversationStatesResponse {
  ok: true;
  statuses: Record<string, "synced" | "stale" | "missing" | "ignored">;
}

export interface ContentSyncResponse extends ProviderSyncResult {
  ok: true;
}

export interface ErrorResponse {
  ok: false;
  error: string;
}

export type SyncResponse = ContentSyncResponse | ErrorResponse;
