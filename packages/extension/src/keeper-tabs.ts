import type { ProviderSource } from "../../shared/src";
import "./chrome-api";

/**
 * Keeper tabs: the extension syncs through a content script, which only exists
 * inside an open provider tab. When nobody keeps one open, capture silently
 * stops, so the background worker keeps one pinned, non-discardable tab per
 * provider and revives it when the browser freezes or discards it.
 *
 * Every chrome.tabs call here is feature-detected and caught individually: a
 * browser that shims the extension API (pinned, autoDiscardable, discarded,
 * reload may be missing) must degrade to the plain "sync whatever tab is open"
 * behavior, never break the periodic sync.
 */

export const KEEPER_STATE_KEY = "scrobbler.keeperTabs";
/** At most one reload per provider in this window, so a signed-out or broken provider cannot loop. */
export const RELOAD_COOLDOWN_MS = 30 * 60 * 1000;
export const keeperTimings = { loadTimeoutMs: 30_000, pollMs: 500, callTimeoutMs: 10_000 };

export const KEEPER_URLS: Record<ProviderSource, string> = {
  chatgpt: "https://chatgpt.com/",
  claude: "https://claude.ai/new",
  gemini: "https://gemini.google.com/app",
};

interface KeeperState {
  tabs: Partial<Record<ProviderSource, number>>;
  /** Last reload or creation per provider (ms since epoch); throttles reloads. */
  touched: Partial<Record<ProviderSource, number>>;
}

const ensuring = new Map<ProviderSource, Promise<any | null>>();

function storageGet(key: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => chrome.storage.local.get(key, resolve));
}
function storageSet(value: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => chrome.storage.local.set(value, resolve));
}

async function readState(): Promise<KeeperState> {
  const stored = (await storageGet(KEEPER_STATE_KEY))[KEEPER_STATE_KEY] as Partial<KeeperState> | undefined;
  return { tabs: { ...stored?.tabs }, touched: { ...stored?.touched } };
}
async function writeState(state: KeeperState): Promise<void> {
  await storageSet({ [KEEPER_STATE_KEY]: state });
}

/** Run a callback-style chrome.tabs call; resolves undefined on a missing API, an error, a throw, or a hang. */
function tabsCall(method: string, ...args: unknown[]): Promise<any> {
  return new Promise((resolve) => {
    const fn = chrome?.tabs?.[method];
    if (typeof fn !== "function") return resolve(undefined);
    const timer = setTimeout(() => resolve(undefined), keeperTimings.callTimeoutMs);
    const done = (value?: unknown) => {
      clearTimeout(timer);
      // Reading lastError marks it handled; a failed call just yields undefined.
      const failed = !!chrome.runtime?.lastError;
      resolve(failed ? undefined : value ?? true);
    };
    try {
      const returned = fn.call(chrome.tabs, ...args, done);
      if (returned && typeof returned.then === "function") returned.then(done, () => done(undefined));
    } catch { clearTimeout(timer); resolve(undefined); }
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Wait (bounded) for a tab to finish loading. Missing tabs.get means nothing to wait on. */
export async function waitForTabLoad(tabId: number): Promise<boolean> {
  const deadline = Date.now() + keeperTimings.loadTimeoutMs;
  for (;;) {
    const tab = await tabsCall("get", tabId);
    if (!tab || tab === true) return false;
    if (tab.status === "complete") return true;
    if (Date.now() >= deadline) return false;
    await sleep(keeperTimings.pollMs);
  }
}

async function pinDown(tabId: number): Promise<void> {
  await tabsCall("update", tabId, { autoDiscardable: false });
}

/** The stored keeper for a provider, if its tab still exists. Re-asserts autoDiscardable:false. */
async function validKeeper(provider: ProviderSource, state: KeeperState, knownTabs: any[]): Promise<any | null> {
  const id = state.tabs[provider];
  if (id === undefined) return null;
  let tab = await tabsCall("get", id);
  if (tab === true) tab = undefined;
  // Without tabs.get, fall back to the tab list the caller already holds.
  if (!tab && typeof chrome?.tabs?.get !== "function") tab = knownTabs.find((t) => t.id === id);
  if (!tab) {
    delete state.tabs[provider];
    await writeState(state);
    return null;
  }
  await pinDown(id);
  return tab;
}

/** Validate every stored keeper (drop closed ones, re-assert autoDiscardable:false) without creating anything. */
export async function validateKeepers(knownTabs: any[]): Promise<void> {
  try {
    const state = await readState();
    for (const provider of Object.keys(state.tabs) as ProviderSource[]) await validKeeper(provider, state, knownTabs);
  } catch { /* best effort */ }
}

async function createKeeper(provider: ProviderSource, state: KeeperState): Promise<any | null> {
  const url = KEEPER_URLS[provider];
  // Prefer pinned+inactive; a shim that rejects `pinned` still gets an inactive tab.
  const tab = (await tabsCall("create", { url, pinned: true, active: false }))
    ?? (await tabsCall("create", { url, active: false }));
  if (!tab || tab === true || typeof tab.id !== "number") return null;
  state.tabs[provider] = tab.id;
  state.touched[provider] = Date.now();
  await writeState(state);
  await pinDown(tab.id);
  await waitForTabLoad(tab.id);
  return tab;
}

/** Return the provider's keeper tab, creating one only if none exists. Never opens a second. */
export function ensureKeeperTab(provider: ProviderSource, knownTabs: any[] = []): Promise<any | null> {
  const running = ensuring.get(provider);
  if (running) return running;
  const job = (async () => {
    const state = await readState();
    return (await validKeeper(provider, state, knownTabs)) ?? (await createKeeper(provider, state));
  })().catch(() => null).finally(() => ensuring.delete(provider));
  ensuring.set(provider, job);
  return job;
}

/**
 * A tab did not answer the sync message. Returns the tab to retry on, or null
 * when there is nothing safe to do (the caller then reports the failure as before).
 *  - keeper or discarded tab: reload it (rate-limited), wait for load.
 *  - user's own live tab: never reload it (they may be typing); use the keeper instead.
 */
export async function recoverDeadTab(provider: ProviderSource, tab: any): Promise<any | null> {
  try {
    const state = await readState();
    if (state.tabs[provider] === tab.id || tab.discarded === true) {
      if (typeof chrome?.tabs?.reload !== "function") return null;
      if (Date.now() - (state.touched[provider] ?? 0) < RELOAD_COOLDOWN_MS) return null;
      state.touched[provider] = Date.now();
      await writeState(state);
      if (!(await tabsCall("reload", tab.id))) return null;
      await waitForTabLoad(tab.id);
      return tab;
    }
    const fallback = await ensureKeeperTab(provider);
    return fallback && fallback.id !== tab.id ? fallback : null;
  } catch { return null; }
}
