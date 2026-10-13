import "./chrome-api";
import { detectProvider } from "./providers";
import { runSidebarBadges } from "./sidebar";
import type { ConversationState } from "./sidebar/reconcile";
import { ASSET_CHUNK_BYTES } from "./asset-transfers";
import { backfillProviderAssets } from "./asset-backfill";
import { backgroundAssetError } from "./providers/asset-cache-client";
import { retryCapturedFailures } from "./retry-captures";
import { DeterministicCaptureError, TransientSyncError } from "./providers/sync-errors";
import type { RuntimeMessage, SyncRequest, SyncResponse } from "./messages";
import type { RawCapture, UploadedAsset } from "../../shared/src";
import type { AssetUploadRequest } from "./messages";

const provider = detectProvider();

if (provider) {
  sendRuntimeMessage({ type: "SCROBBLER_PROVIDER_READY", provider: provider.source }).catch(() => undefined);

  chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender: unknown, sendResponse: (response: any) => void) => {
    if (message.type === "SCROBBLER_BACKFILL_ASSETS" && message.provider === provider.source) {
      refreshIgnoredIds().then(() => backfillProviderAssets(provider, message.page, {
        uploadAsset, shouldIgnore: id => ignoredIds.has(id),
        commit: async value => { const res = await sendRuntimeMessage({ type: "SCROBBLER_BACKFILL_COMMIT", value }); if (!res?.ok) throw new Error(res?.error ?? "Backfill commit failed"); },
      })).then(result => sendResponse({ ok: true, result }), () => sendResponse({ ok: false, error: "Asset backfill failed; inspect receiver reports" }));
      return true;
    }
    if (message.type !== "SCROBBLER_SYNC_REQUEST" || message.provider !== provider.source) return false;
    syncProvider(message).then(sendResponse, (error) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
    return true;
  });

  // iCloud-style per-chat sync badges in the site's own sidebar.
  runSidebarBadges(provider, {
    getStates: async (conversations) => {
      const res = await sendRuntimeMessage({ type: "SCROBBLER_CONVERSATION_STATES", provider: provider.source, conversations });
      return (res?.ok ? res.statuses : {}) as Record<string, ConversationState>;
    },
    getAutoSync: async () => {
      const res = await sendRuntimeMessage({ type: "SCROBBLER_GET_STATUS" });
      return !!(res?.ok && res.settings?.autoSync);
    },
    getIgnoredIds: async () => {
      const res = await sendRuntimeMessage({ type: "SCROBBLER_IGNORED_CHATS", provider: provider.source });
      return new Set<string>(res?.ok && Array.isArray(res.ids) ? res.ids : []);
    },
    toggleIgnored: async (id) => {
      const res = await sendRuntimeMessage({ type: "SCROBBLER_TOGGLE_IGNORED_CHAT", provider: provider.source, id });
      if (!res?.ok) throw new Error(res?.error ?? "Failed to toggle ignored chat");
      return !!res.ignored;
    },
    deleteCapture: async (id) => {
      const res = await sendRuntimeMessage({ type: "SCROBBLER_DELETE_CAPTURE", provider: provider.source, id });
      if (!res?.ok) throw new Error(res?.error ?? "Failed to delete local capture");
    },
    emitCapture: async (capture) => { await emitCapture(capture); },
    uploadAsset,
    reportCaptureProgress: async (remaining, total) => {
      await sendRuntimeMessage({ type: "SCROBBLER_CAPTURE_PROGRESS", remaining, total });
    },
    onCaptured: (id, title, kind) => {
      sendRuntimeMessage({
        type: "SCROBBLER_CAPTURE_LOGGED",
        id,
        title,
        capturedAt: new Date().toISOString(),
        kind,
      }).catch(() => undefined);
    },
  });
}

async function syncProvider(message: SyncRequest): Promise<SyncResponse> {
  await refreshIgnoredIds();
  if (message.retryFailed) return retryFailedCaptures(message);
  const result = await provider!.sync({
    lastSync: message.lastSync ?? null,
    captureFailures: message.captureFailures,
    emitCapture,
    shouldIgnore: (_source, sourceId) => ignoredIds.has(sourceId),
    uploadAsset,
  });
  return { ok: true, ...result };
}

async function uploadAsset(asset: AssetUploadRequest): Promise<UploadedAsset> {
  let response: any;
  if (asset.bytes.length <= ASSET_CHUNK_BYTES) {
    response = await sendRuntimeMessage({ type: "SCROBBLER_ASSET_UPLOAD", asset: { ...asset, bytes: Array.from(asset.bytes) } });
  } else {
    const { bytes, ...metadata } = asset;
    const start = await sendRuntimeMessage({ type: "SCROBBLER_ASSET_UPLOAD_START", asset: metadata, sizeBytes: bytes.length });
    if (!start?.ok) throw new Error(start?.error ?? "Asset transfer could not start");
    try {
      for (let offset = 0; offset < bytes.length; offset += ASSET_CHUNK_BYTES) {
        const chunk = await sendRuntimeMessage({ type: "SCROBBLER_ASSET_UPLOAD_CHUNK", uploadId: start.uploadId, offset, bytes: Array.from(bytes.slice(offset, offset + ASSET_CHUNK_BYTES)) });
        if (!chunk?.ok) throw new Error(chunk?.error ?? "Asset chunk rejected");
      }
      response = await sendRuntimeMessage({ type: "SCROBBLER_ASSET_UPLOAD_FINISH", uploadId: start.uploadId });
    } catch (error) {
      await sendRuntimeMessage({ type: "SCROBBLER_ASSET_UPLOAD_CANCEL", uploadId: start.uploadId });
      throw error;
    }
  }
  if (!response?.ok) throw backgroundAssetError(response);
  return response.asset as UploadedAsset;
}

async function emitCapture(capture: RawCapture): Promise<boolean> {
  const response = await sendRuntimeMessage({ type: "SCROBBLER_CAPTURE_READY", capture });
  if (response?.ignored || response?.captured === false) return false;
  if (!response?.ok) throw response?.error_type === "deterministic"
    ? new DeterministicCaptureError("Receiver rejected capture") : new TransientSyncError("Receiver temporarily unavailable");
  return true;
}

function sendRuntimeMessage(message: RuntimeMessage): Promise<any> {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

let ignoredIds = new Set<string>();

async function refreshIgnoredIds(): Promise<void> {
  const res = await sendRuntimeMessage({ type: "SCROBBLER_IGNORED_CHATS", provider: provider!.source });
  ignoredIds = new Set<string>(res?.ok && Array.isArray(res.ids) ? res.ids : []);
}

async function retryFailedCaptures(message: SyncRequest): Promise<SyncResponse> {
  const result = await retryCapturedFailures(provider!, { lastSync: message.lastSync, captureFailures: message.captureFailures,
    emitCapture, uploadAsset, shouldIgnore: (_source, id) => ignoredIds.has(id) });
  return { ok: true, ...result };
}
