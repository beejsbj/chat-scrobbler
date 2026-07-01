import "./chrome-api";
import { assetsUrl, capturesUrl, deleteCaptureUrl, statusUrl, DEFAULT_INGEST_BASE_URL, DEFAULT_SYNC_PERIOD_MINUTES, type ProviderSource } from "../../shared/src";
import { collectCredentialSnapshot } from "./credentials";
import { toolbarProgressView, aggregateTabProgress, type ToolbarProgressInput } from "./toolbar-progress";
import { appendRecentCapture, RECENT_CAPTURES_KEY, type RecentCapture } from "./recent-captures";
import { filenameFromHeaders, isOversizedContentLength, MAX_PROVIDER_ASSET_BYTES } from "./providers/assets";
import type {
  AssetFetchMessage,
  CaptureLoggedMessage,
  CaptureProgressMessage,
  CaptureReadyMessage,
  ConversationStatesMessage,
  RuntimeMessage,
  SaveSettingsMessage,
  SyncResponse,
  AssetUploadRequest,
  DeleteCaptureMessage,
} from "./messages";

interface Settings {
  ingestBaseUrl: string;
  syncPeriodMinutes: number;
  /** When true, opening a provider tab auto-captures not-yet-synced conversations. */
  autoSync: boolean;
  /**
   * Optional shared secret that matches the INGEST_TOKEN env var on the receiver.
   * When set, the extension adds `Authorization: Bearer <token>` to every POST
   * /captures request. Leave empty for local dev (no auth).
   */
  ingestToken?: string | null;
}

interface ProviderState {
  lastSync: string | null;
  lastVisitSync: string | null;
  lastResult: unknown;
  lastError: string | null;
}

interface Status {
  lastCaptureAt: string | null;
  capturesPosted: number;
  providers: Partial<Record<ProviderSource, ProviderState>>;
}

const SETTINGS_KEY = "scrobbler.settings";
const STATUS_KEY = "scrobbler.status";
const IGNORED_CHATS_KEY = "scrobbler.ignoredChats";
const VISIT_COOLDOWN_MS = 10 * 60 * 1000;
const SPINNER_INTERVAL_MS = 90;

let spinnerTimer: ReturnType<typeof setInterval> | null = null;
let fallbackSpinnerTimer: ReturnType<typeof setInterval> | null = null;
let spinnerFrame = 0;

/** Per-tab capture progress. Keyed by tab id; no-tab-id messages use the
 *  sentinel key NOTAB_KEY so they never collide with real tab ids. */
const TAB_PROGRESS = new Map<number, ToolbarProgressInput>();
const NOTAB_KEY = -1;

chrome.tabs.onRemoved.addListener((tabId: number) => {
  if (TAB_PROGRESS.delete(tabId)) {
    // A tab closed mid-sync; re-compute so the badge doesn't stay stuck.
    applyAggregateProgress();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  getSettings().then((settings) => setSettings(settings));
  drawAndSetToolbarIcon(false);
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  drawAndSetToolbarIcon(false);
});

chrome.alarms.onAlarm.addListener((alarm: { name: string }) => {
  if (alarm.name === "scrobbler.periodic") syncAllOpenProviderTabs("periodic").catch(console.error);
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender: any, sendResponse: (response: unknown) => void) => {
  handleRuntimeMessage(message, sender).then(sendResponse, (error) => {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
  });
  return true;
});

async function handleRuntimeMessage(message: RuntimeMessage, sender: any): Promise<unknown> {
  if (message.type === "SCROBBLER_CAPTURE_READY") return postCapture(message);
  if (message.type === "SCROBBLER_ASSET_UPLOAD") return postAsset(message.asset);
  if (message.type === "SCROBBLER_ASSET_FETCH") return fetchAssetBytes(message);
  if (message.type === "SCROBBLER_PROVIDER_READY" && sender.tab?.id) {
    maybeSyncVisitedTab(sender.tab, message.provider).catch(console.error);
    return { ok: true };
  }
  if (message.type === "SCROBBLER_SYNC_ACTIVE_TAB") return syncActiveTab();
  if (message.type === "SCROBBLER_SYNC_ALL_OPEN_TABS") return syncAllOpenProviderTabs("manual");
  if (message.type === "SCROBBLER_CONVERSATION_STATES") return getConversationStates(message);
  if (message.type === "SCROBBLER_IGNORED_CHATS") return listIgnoredChats(message.provider);
  if (message.type === "SCROBBLER_TOGGLE_IGNORED_CHAT") return toggleIgnoredChat(message.provider, message.id);
  if (message.type === "SCROBBLER_DELETE_CAPTURE") return deleteCapture(message);
  if (message.type === "SCROBBLER_CAPTURE_PROGRESS") return updateToolbarProgress(message, sender);
  if (message.type === "SCROBBLER_GET_STATUS") return { ok: true, settings: await getSettings(), status: await getStatus() };
  if (message.type === "SCROBBLER_SAVE_SETTINGS") {
    const patch: Partial<Settings> = { ingestBaseUrl: message.ingestBaseUrl };
    if ("ingestToken" in message) patch.ingestToken = (message as SaveSettingsMessage).ingestToken ?? null;
    if ("autoSync" in message) patch.autoSync = (message as SaveSettingsMessage).autoSync ?? true;
    const settings = await setSettings({ ...(await getSettings()), ...patch });
    return { ok: true, settings };
  }
  if (message.type === "SCROBBLER_SNAPSHOT_CREDENTIALS") {
    const snapshot = await collectCredentialSnapshot(message.provider, false);
    return { ok: true, snapshot };
  }
  if (message.type === "SCROBBLER_CAPTURE_LOGGED") return logRecentCapture(message);
  return { ok: false, error: "Unknown message" };
}

async function postAsset(asset: AssetUploadRequest): Promise<unknown> {
  const settings = await getSettings();
  const headers: Record<string, string> = {};
  if (asset.contentType) headers["content-type"] = asset.contentType;
  if (settings.ingestToken) headers["authorization"] = `Bearer ${settings.ingestToken}`;
  const url = new URL(assetsUrl(settings.ingestBaseUrl));
  url.searchParams.set("source", asset.source);
  url.searchParams.set("source_id", asset.sourceId);
  url.searchParams.set("pointer", asset.pointer);
  if (asset.filename) url.searchParams.set("filename", asset.filename);
  if (asset.contentType) url.searchParams.set("content_type", asset.contentType);
  const res = await fetch(url.toString(), {
    method: "POST",
    headers,
    body: new Uint8Array(asset.bytes),
  });
  if (!res.ok) throw new Error(`Ingest rejected asset with HTTP ${res.status}: ${await res.text()}`);
  return { ok: true, asset: await res.json() };
}

async function fetchAssetBytes(message: AssetFetchMessage): Promise<unknown> {
  const url = new URL(message.url);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Asset URL must be http or https");
  }
  const res = await fetch(url.toString(), { credentials: "include" });
  if (!res.ok) throw new Error(`Provider rejected asset fetch with HTTP ${res.status}`);
  if (isOversizedContentLength(res.headers.get("content-length"), MAX_PROVIDER_ASSET_BYTES)) {
    throw new Error("Provider asset exceeds the 50 MiB upload limit");
  }
  const buffer = await res.arrayBuffer();
  if (buffer.byteLength > MAX_PROVIDER_ASSET_BYTES) {
    throw new Error("Provider asset exceeds the 50 MiB upload limit");
  }
  return {
    ok: true,
    bytes: Array.from(new Uint8Array(buffer)),
    filename: filenameFromHeaders(res),
    contentType: res.headers.get("content-type"),
  };
}

function updateToolbarProgress(message: CaptureProgressMessage, sender: any): unknown {
  const tabId: number = sender?.tab?.id ?? NOTAB_KEY;
  if (message.remaining <= 0) {
    TAB_PROGRESS.delete(tabId);
  } else {
    TAB_PROGRESS.set(tabId, { remaining: message.remaining, total: message.total });
  }
  applyAggregateProgress();
  return { ok: true };
}

function applyAggregateProgress(): void {
  const aggregate = aggregateTabProgress(TAB_PROGRESS);
  const view = toolbarProgressView(aggregate);
  if (view.badgeColor) chrome.action.setBadgeBackgroundColor({ color: view.badgeColor });
  chrome.action.setBadgeText({ text: view.badgeText });
  if (view.spinning) startToolbarSpinner();
  else stopToolbarSpinner();
}

function startToolbarSpinner(): void {
  if (spinnerTimer || fallbackSpinnerTimer) return;
  if (drawAndSetToolbarIcon(true)) {
    spinnerTimer = setInterval(() => drawAndSetToolbarIcon(true), SPINNER_INTERVAL_MS);
    return;
  }
  startFallbackBadgeSpinner();
}

function stopToolbarSpinner(): void {
  if (spinnerTimer) clearInterval(spinnerTimer);
  if (fallbackSpinnerTimer) clearInterval(fallbackSpinnerTimer);
  spinnerTimer = null;
  fallbackSpinnerTimer = null;
  spinnerFrame = 0;
  drawAndSetToolbarIcon(false);
}

function drawAndSetToolbarIcon(spinning: boolean): boolean {
  const imageData = drawToolbarIcon(spinning ? spinnerFrame++ : 0, spinning);
  if (!imageData) return false;
  chrome.action.setIcon({ imageData });
  return true;
}

function drawToolbarIcon(frame: number, spinning: boolean): Record<number, ImageData> | null {
  if (typeof OffscreenCanvas === "undefined") return null;
  const imageData: Record<number, ImageData> = {};
  for (const size of [16, 32]) {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.clearRect(0, 0, size, size);
    const center = size / 2;
    const radius = size * 0.40;
    ctx.lineWidth = Math.max(1.5, size * 0.09);
    ctx.lineCap = "round";
    ctx.strokeStyle = "#0969da";
    ctx.fillStyle = "#0969da";
    if (spinning) {
      // Spinner arc
      const start = (frame % 40) * (Math.PI / 20);
      ctx.beginPath();
      ctx.arc(center, center, radius, start, start + Math.PI * 1.35);
      ctx.stroke();
    } else {
      // Default logo: outer ring + inner filled dot
      ctx.beginPath();
      ctx.arc(center, center, radius, 0, Math.PI * 2);
      ctx.stroke();
      // Inner filled dot
      ctx.beginPath();
      ctx.arc(center, center, size * 0.14, 0, Math.PI * 2);
      ctx.fill();
      // Three satellite dots (top, right, left) at reduced opacity
      ctx.globalAlpha = 0.45;
      const dotR = size * 0.07;
      const orbitR = radius;
      // Top
      ctx.beginPath();
      ctx.arc(center, center - orbitR, dotR, 0, Math.PI * 2);
      ctx.fill();
      // Right
      ctx.beginPath();
      ctx.arc(center + orbitR, center, dotR, 0, Math.PI * 2);
      ctx.fill();
      // Left
      ctx.beginPath();
      ctx.arc(center - orbitR, center, dotR, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    imageData[size] = ctx.getImageData(0, 0, size, size);
  }
  return imageData;
}

function startFallbackBadgeSpinner(): void {
  const frames = ["◐", "◓", "◑", "◒"];
  let frame = 0;
  fallbackSpinnerTimer = setInterval(() => {
    chrome.action.setBadgeText({ text: frames[frame++ % frames.length] });
  }, SPINNER_INTERVAL_MS);
}

async function postCapture(message: CaptureReadyMessage): Promise<unknown> {
  if (await isIgnoredChat(message.capture.source, message.capture.source_id)) {
    return { ok: false, captured: false, ignored: true, error: "Capture ignored" };
  }
  const settings = await getSettings();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (settings.ingestToken) headers["authorization"] = `Bearer ${settings.ingestToken}`;
  const res = await fetch(capturesUrl(settings.ingestBaseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify(message.capture),
  });
  if (!res.ok) throw new Error(`Ingest rejected capture with HTTP ${res.status}: ${await res.text()}`);
  await mutateStatus((status) => {
    status.lastCaptureAt = new Date().toISOString();
    status.capturesPosted += 1;
  });
  return { ok: true, captured: true, ingest: await res.json() };
}

async function deleteCapture(message: DeleteCaptureMessage): Promise<unknown> {
  const settings = await getSettings();
  const headers: Record<string, string> = {};
  if (settings.ingestToken) headers["authorization"] = `Bearer ${settings.ingestToken}`;
  const res = await fetch(deleteCaptureUrl(settings.ingestBaseUrl, message.provider, message.id), {
    method: "DELETE",
    headers,
  });
  if (!res.ok) throw new Error(`Delete request failed with HTTP ${res.status}: ${await res.text()}`);
  return { ok: true, delete: await res.json() };
}

async function getConversationStates(message: ConversationStatesMessage): Promise<unknown> {
  const ignored = await getIgnoredChatKeys();
  const ignoredStatuses: Record<string, string> = {};
  const conversations = message.conversations.filter((conversation) => {
    if (!ignored.has(ignoreKey(message.provider, conversation.id))) return true;
    ignoredStatuses[conversation.id] = "ignored";
    return false;
  });
  if (conversations.length === 0) return { ok: true, statuses: ignoredStatuses };

  const settings = await getSettings();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (settings.ingestToken) headers["authorization"] = `Bearer ${settings.ingestToken}`;
  const res = await fetch(statusUrl(settings.ingestBaseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify({
      source: message.provider,
      conversations: conversations.map((c) => ({ id: c.id, updated_at: c.updatedAt })),
    }),
  });
  if (!res.ok) throw new Error(`Status request failed with HTTP ${res.status}`);
  const body = await res.json() as { statuses?: Record<string, string> };
  const statuses = { ...(body.statuses ?? {}), ...ignoredStatuses };
  return { ok: true, statuses };
}

async function maybeSyncVisitedTab(tab: any, provider: ProviderSource): Promise<void> {
  const status = await getStatus();
  const state = status.providers[provider];
  if (state?.lastVisitSync && Date.now() - Date.parse(state.lastVisitSync) < VISIT_COOLDOWN_MS) return;
  await syncTab(tab, provider, "visit");
}

async function syncActiveTab(): Promise<unknown> {
  const [tab] = await queryTabs({ active: true, currentWindow: true });
  const provider = providerFromUrl(tab?.url);
  if (!tab?.id || !provider) throw new Error("Open ChatGPT or Claude in the active tab first");
  return syncTab(tab, provider, "manual");
}

async function syncAllOpenProviderTabs(reason: "manual" | "periodic"): Promise<unknown> {
  const tabs = await queryTabs({});
  const results = [];
  for (const tab of tabs) {
    const provider = providerFromUrl(tab.url);
    if (tab.id && provider) results.push(await syncTab(tab, provider, reason));
  }
  return { ok: true, results };
}

async function syncTab(tab: any, provider: ProviderSource, reason: "manual" | "periodic" | "visit"): Promise<unknown> {
  const status = await getStatus();
  const lastSync = status.providers[provider]?.lastSync ?? null;
  // sendTabMessage resolves undefined when the tab has no live content script
  // (e.g. opened before the extension loaded / reloaded). Guard with optional
  // chaining so this surfaces a clear message instead of a "reading 'ok'" crash.
  const response = await sendTabMessage(tab.id, { type: "SCROBBLER_SYNC_REQUEST", provider, lastSync }) as SyncResponse | undefined;
  if (!response?.ok) throw new Error(response?.error ?? "Content script not active in that tab — reload the tab and try again.");

  await mutateStatus((next) => {
    next.providers[provider] = {
      lastSync: response.maxConversationUpdatedAt ?? lastSync,
      lastVisitSync: reason === "visit" ? new Date().toISOString() : next.providers[provider]?.lastVisitSync ?? null,
      lastResult: { ...response, reason, tabId: tab.id, synced_at: new Date().toISOString() },
      lastError: null,
    };
  });
  return { ok: true, result: response };
}

function providerFromUrl(rawUrl?: string): ProviderSource | null {
  if (!rawUrl) return null;
  const url = new URL(rawUrl);
  if (url.hostname === "chatgpt.com" || url.hostname === "chat.openai.com") return "chatgpt";
  if (url.hostname === "claude.ai") return "claude";
  if (url.hostname === "gemini.google.com") return "gemini";
  return null;
}

// Dev ports that earlier builds defaulted to / were pointed at; migrate any of
// them to the current default so the prefilled receiver URL "just works".
const STALE_INGEST_URLS = new Set(["http://127.0.0.1:4319", "http://127.0.0.1:4321"]);

async function getSettings(): Promise<Settings> {
  const stored = await storageGet(SETTINGS_KEY);
  const settings = (stored[SETTINGS_KEY] as Settings | undefined) ?? {
    ingestBaseUrl: DEFAULT_INGEST_BASE_URL,
    syncPeriodMinutes: DEFAULT_SYNC_PERIOD_MINUTES,
    autoSync: true,
  };
  if (STALE_INGEST_URLS.has(settings.ingestBaseUrl.replace(/\/+$/, ""))) {
    settings.ingestBaseUrl = DEFAULT_INGEST_BASE_URL;
  }
  if (settings.autoSync === undefined) settings.autoSync = true;
  return settings;
}

async function setSettings(settings: Settings): Promise<Settings> {
  await storageSet({ [SETTINGS_KEY]: settings });
  chrome.alarms.create("scrobbler.periodic", { periodInMinutes: settings.syncPeriodMinutes });
  return settings;
}

async function getStatus(): Promise<Status> {
  const stored = await storageGet(STATUS_KEY);
  return (stored[STATUS_KEY] as Status | undefined) ?? { lastCaptureAt: null, capturesPosted: 0, providers: {} };
}

async function mutateStatus(mutator: (status: Status) => void): Promise<void> {
  const status = await getStatus();
  mutator(status);
  await storageSet({ [STATUS_KEY]: status });
}

async function logRecentCapture(message: CaptureLoggedMessage): Promise<unknown> {
  const stored = await storageGet(RECENT_CAPTURES_KEY);
  const existing = (stored[RECENT_CAPTURES_KEY] as RecentCapture[] | undefined) ?? [];
  const updated = appendRecentCapture(existing, {
    id: message.id,
    title: message.title,
    capturedAt: message.capturedAt,
    kind: message.kind,
  });
  await storageSet({ [RECENT_CAPTURES_KEY]: updated });
  return { ok: true };
}

async function listIgnoredChats(provider: ProviderSource): Promise<unknown> {
  const ignored = await getIgnoredChatKeys();
  const prefix = `${provider}:`;
  return {
    ok: true,
    ids: [...ignored]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length)),
  };
}

async function toggleIgnoredChat(provider: ProviderSource, id: string): Promise<unknown> {
  const key = ignoreKey(provider, id);
  const ignored = await getIgnoredChatKeys();
  const nextIgnored = !ignored.has(key);
  if (nextIgnored) ignored.add(key);
  else ignored.delete(key);
  await setIgnoredChatKeys(ignored);
  return { ok: true, ignored: nextIgnored };
}

async function isIgnoredChat(provider: ProviderSource, id: string): Promise<boolean> {
  return (await getIgnoredChatKeys()).has(ignoreKey(provider, id));
}

function ignoreKey(provider: ProviderSource, id: string): string {
  return `${provider}:${id}`;
}

async function getIgnoredChatKeys(): Promise<Set<string>> {
  const stored = await storageGet(IGNORED_CHATS_KEY);
  const value = stored[IGNORED_CHATS_KEY];
  return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
}

async function setIgnoredChatKeys(keys: Set<string>): Promise<void> {
  await storageSet({ [IGNORED_CHATS_KEY]: [...keys].sort() });
}

function ensureAlarm(): void {
  chrome.alarms.create("scrobbler.periodic", { periodInMinutes: DEFAULT_SYNC_PERIOD_MINUTES });
}

function storageGet(key: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => chrome.storage.local.get(key, resolve));
}

function storageSet(value: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => chrome.storage.local.set(value, resolve));
}

function queryTabs(queryInfo: Record<string, unknown>): Promise<any[]> {
  return new Promise((resolve) => chrome.tabs.query(queryInfo, resolve));
}

function sendTabMessage(tabId: number, message: unknown): Promise<unknown> {
  return new Promise((resolve) => chrome.tabs.sendMessage(tabId, message, resolve));
}
