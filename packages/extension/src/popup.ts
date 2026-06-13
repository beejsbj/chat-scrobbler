import "./chrome-api";
import { DEFAULT_INGEST_BASE_URL } from "../../shared/src";
import { RECENT_CAPTURES_KEY, type RecentCapture } from "./recent-captures";

// ---- element refs ----
const autoSyncToggle = document.querySelector<HTMLInputElement>("#auto-sync")!;
const ingestInput    = document.querySelector<HTMLInputElement>("#ingest-url")!;
const syncAllButton  = document.querySelector<HTMLButtonElement>("#sync-all")!;
const captureCountEl = document.querySelector<HTMLElement>("#capture-count")!;
const lastCaptureEl  = document.querySelector<HTMLElement>("#last-capture")!;
const sessionListEl  = document.querySelector<HTMLUListElement>("#session-list")!;
const sessionBadgeEl = document.querySelector<HTMLElement>("#session-count-badge")!;
const receiverStateEl= document.querySelector<HTMLElement>("#receiver-state")!;

// Error banner is injected lazily so the HTML stays clean.
let errorBanner: HTMLElement | null = null;

function getOrCreateErrorBanner(): HTMLElement {
  if (errorBanner) return errorBanner;
  errorBanner = document.createElement("div");
  errorBanner.className = "error-banner";
  // Insert before the receiver details block
  const receiverDetails = document.querySelector(".receiver-details");
  receiverDetails?.parentNode?.insertBefore(errorBanner, receiverDetails);
  return errorBanner;
}

function showError(msg: string): void {
  const banner = getOrCreateErrorBanner();
  banner.textContent = `${msg}`;
  banner.classList.add("visible");
}

function clearError(): void {
  const banner = getOrCreateErrorBanner();
  banner.classList.remove("visible");
}

// ---- recent captures list (persisted in chrome.storage.local) ----
function renderSessionList(entries: RecentCapture[]): void {
  sessionBadgeEl.textContent = String(entries.length);
  if (entries.length === 0) {
    sessionListEl.innerHTML = '<li class="session-empty">No captures yet this session.</li>';
    return;
  }
  sessionListEl.innerHTML = entries
    .map(({ title, capturedAt, kind }) => {
      const kindLabel = kind === "new" ? "new" : "updated";
      return `<li><span class="session-title">${escHtml(title)}</span><span class="session-kind" data-kind="${escHtml(kind ?? "new")}">${escHtml(kindLabel)}</span><span class="session-time">${escHtml(formatTime(capturedAt))}</span></li>`;
    })
    .join("");
}

function loadAndRenderCaptures(): void {
  chrome.storage.local.get(RECENT_CAPTURES_KEY, (stored: Record<string, unknown>) => {
    const entries = (stored[RECENT_CAPTURES_KEY] as RecentCapture[] | undefined) ?? [];
    renderSessionList(entries);
  });
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---- per-site theming ----
async function applyTheme(): Promise<void> {
  try {
    const tabs = await queryTabs({ active: true, currentWindow: true });
    const url = tabs[0]?.url;
    if (!url) return;
    const hostname = new URL(url).hostname;
    let site: string | null = null;
    if (hostname === "chatgpt.com" || hostname === "chat.openai.com") site = "chatgpt";
    else if (hostname === "claude.ai") site = "claude";
    else if (hostname === "gemini.google.com") site = "gemini";
    if (site) document.body.setAttribute("data-site", site);
  } catch {
    // not a provider tab, no theme
  }
}

// ---- event handlers ----
autoSyncToggle.addEventListener("change", () => guard(saveSettings));
ingestInput.addEventListener("change",    () => guard(saveSettings));
syncAllButton.addEventListener("click",   () => guard(syncAll));

// ---- init ----
void applyTheme();
void guard(refreshStatus);

// ---- core functions ----
async function guard(fn: () => Promise<void>): Promise<void> {
  try {
    clearError();
    await fn();
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  }
}

async function syncAll(): Promise<void> {
  syncAllButton.disabled = true;
  syncAllButton.textContent = "Syncing…";
  try {
    const res = await sendMessage({ type: "SCROBBLER_SYNC_ALL_OPEN_TABS" });
    if (!res?.ok) throw new Error(res?.error ?? "Sync failed");
    await refreshStatus();
  } finally {
    syncAllButton.disabled = false;
    syncAllButton.textContent = "Sync open tabs now";
  }
}

async function saveSettings(): Promise<void> {
  const res = await sendMessage({
    type: "SCROBBLER_SAVE_SETTINGS",
    ingestBaseUrl: ingestInput.value.trim() || DEFAULT_INGEST_BASE_URL,
    autoSync: autoSyncToggle.checked,
  });
  if (!res?.ok) throw new Error(res?.error ?? "Save failed");
  await refreshStatus();
}

async function refreshStatus(): Promise<void> {
  const res = await sendMessage({ type: "SCROBBLER_GET_STATUS" });
  if (!res?.ok) throw new Error(res?.error ?? "Status unavailable");

  const settings = res.settings ?? {};
  const s = res.status ?? {};

  ingestInput.value = settings.ingestBaseUrl ?? DEFAULT_INGEST_BASE_URL;
  autoSyncToggle.checked = settings.autoSync ?? true;

  // Footer stats
  const count = s.capturesPosted ?? 0;
  captureCountEl.textContent = `${count} captured`;
  lastCaptureEl.textContent = formatTime(s.lastCaptureAt);

  // Receiver state indicator
  setReceiverState(settings.ingestBaseUrl ?? DEFAULT_INGEST_BASE_URL);

  // Recent captures list
  loadAndRenderCaptures();
}

function setReceiverState(url: string): void {
  try {
    const parsed = new URL(url);
    const display = parsed.hostname + (parsed.port ? `:${parsed.port}` : "");
    receiverStateEl.textContent = display;
    receiverStateEl.className = "receiver-state ok";
  } catch {
    receiverStateEl.textContent = "invalid url";
    receiverStateEl.className = "receiver-state err";
  }
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const now = new Date();
  // Same day: show time only
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" }) +
    " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ---- chrome helpers ----
function sendMessage(message: unknown): Promise<any> {
  return new Promise((resolve) =>
    chrome.runtime.sendMessage(message, (res: unknown) => {
      const err = chrome.runtime.lastError;
      if (err) resolve({ ok: false, error: err.message ?? "Background worker unavailable — reopen the popup." });
      else resolve(res);
    }),
  );
}

function queryTabs(queryInfo: Record<string, unknown>): Promise<Array<{ url?: string }>> {
  return new Promise((resolve) => chrome.tabs.query(queryInfo, resolve));
}

// Live-update the captures list while the popup is open.
chrome.storage.onChanged.addListener((changes: Record<string, { newValue?: unknown }>, area: string) => {
  if (area === "local" && RECENT_CAPTURES_KEY in changes) {
    const entries = (changes[RECENT_CAPTURES_KEY]!.newValue as RecentCapture[] | undefined) ?? [];
    renderSessionList(entries);
  }
});
