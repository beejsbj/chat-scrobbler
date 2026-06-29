import "./chrome-api";
import { detectProvider } from "./providers";
import { runSidebarBadges } from "./sidebar";
import type { ConversationState } from "./sidebar/reconcile";
import type { RuntimeMessage, SyncRequest, SyncResponse } from "./messages";
import type { RawCapture, UploadedAsset } from "../../shared/src";
import type { AssetUploadRequest } from "./messages";

const provider = detectProvider();

if (provider) {
  sendRuntimeMessage({ type: "SCROBBLER_PROVIDER_READY", provider: provider.source }).catch(() => undefined);

  chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender: unknown, sendResponse: (response: SyncResponse) => void) => {
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
    emitCapture,
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
  const result = await provider!.sync({
    lastSync: message.lastSync ?? null,
    emitCapture,
    shouldIgnore: (_source, sourceId) => ignoredIds.has(sourceId),
    uploadAsset,
  });
  return { ok: true, ...result };
}

async function uploadAsset(asset: AssetUploadRequest): Promise<UploadedAsset> {
  const response = await sendRuntimeMessage({ type: "SCROBBLER_ASSET_UPLOAD", asset });
  if (!response?.ok) throw new Error(response?.error ?? "Background asset upload failed");
  return response.asset as UploadedAsset;
}

async function emitCapture(capture: RawCapture): Promise<void> {
  const response = await sendRuntimeMessage({ type: "SCROBBLER_CAPTURE_READY", capture });
  if (!response?.ok) throw new Error(response?.error ?? "Background ingest failed");
}

function sendRuntimeMessage(message: RuntimeMessage): Promise<any> {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

let ignoredIds = new Set<string>();

async function refreshIgnoredIds(): Promise<void> {
  const res = await sendRuntimeMessage({ type: "SCROBBLER_IGNORED_CHATS", provider: provider!.source });
  ignoredIds = new Set<string>(res?.ok && Array.isArray(res.ids) ? res.ids : []);
}
