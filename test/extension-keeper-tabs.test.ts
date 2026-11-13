import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { keeperTimings, RELOAD_COOLDOWN_MS } from "../packages/extension/src/keeper-tabs";

const originalFetch = globalThis.fetch;
const originalChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
const storageData: Record<string, unknown> = {};
let syncAll: (reason: "manual" | "periodic" | "retry") => Promise<any>;

interface FakeTab { id: number; url: string; active?: boolean; discarded?: boolean; pinned?: boolean; autoDiscardable?: boolean; status?: string }
let tabs: FakeTab[] = [];
let nextId = 100;
let calls: Array<[string, ...unknown[]]> = [];
/** Tab ids whose content script answers sync messages. */
let alive = new Set<number>();
let sendLog: number[] = [];
let tabsApi: any;
let chromeStub: any;

function installChrome(): void {
  tabsApi = {
    onRemoved: { addListener: () => undefined },
    query: (_q: unknown, cb: (t: FakeTab[]) => void) => cb(tabs.map((t) => ({ ...t }))),
    get: (id: number, cb: (t?: FakeTab) => void) => {
      const tab = tabs.find((t) => t.id === id);
      if (!tab) chromeStub.runtime.lastError = { message: "No tab with id" };
      cb(tab ? { ...tab } : undefined);
      chromeStub.runtime.lastError = undefined;
    },
    create: (props: any, cb: (t: FakeTab) => void) => {
      calls.push(["create", props]);
      const tab: FakeTab = { id: nextId++, url: props.url, active: props.active, pinned: props.pinned, status: "complete" };
      tabs.push(tab);
      alive.add(tab.id);
      cb({ ...tab });
    },
    update: (id: number, props: any, cb: (t?: FakeTab) => void) => {
      calls.push(["update", id, props]);
      const tab = tabs.find((t) => t.id === id);
      if (tab) Object.assign(tab, props);
      cb(tab ? { ...tab } : undefined);
    },
    reload: (id: number, cb: () => void) => {
      calls.push(["reload", id]);
      const tab = tabs.find((t) => t.id === id);
      if (tab) { tab.discarded = false; alive.add(id); }
      cb();
    },
    sendMessage: (id: number, request: any, cb: (r: unknown) => void) => {
      sendLog.push(id);
      cb(alive.has(id) ? { ok: true, source: request.provider, captureFailures: [], scanned: 0, captured: 0, skipped: 0, account: null, maxConversationUpdatedAt: null } : undefined);
    },
  };
  chromeStub = {
    action: { setBadgeBackgroundColor: () => undefined, setBadgeText: () => undefined, setIcon: () => undefined },
    alarms: { create: () => undefined, onAlarm: { addListener: () => undefined } },
    runtime: { lastError: undefined, onInstalled: { addListener: () => undefined }, onMessage: { addListener: () => undefined }, onStartup: { addListener: () => undefined } },
    storage: { local: {
      get: (key: string, cb: (v: Record<string, unknown>) => void) => cb({ [key]: storageData[key] }),
      set: (v: Record<string, unknown>, cb: () => void) => { Object.assign(storageData, v); cb(); },
    } },
    tabs: tabsApi,
  };
  Object.defineProperty(globalThis, "chrome", { configurable: true, writable: true, value: chromeStub });
}

beforeAll(async () => {
  installChrome();
  // A query string gives this file its own module instance, so it does not steal the listeners the other background test registers.
  const specifier = "../packages/extension/src/background?keeper-tabs";
  syncAll = (await import(specifier)).syncAllOpenProviderTabs as typeof syncAll;
});
afterAll(() => {
  if (originalChrome) Object.defineProperty(globalThis, "chrome", originalChrome);
  else Reflect.deleteProperty(globalThis, "chrome");
});
afterEach(() => { globalThis.fetch = originalFetch; });
beforeEach(() => {
  installChrome();
  for (const key of Object.keys(storageData)) delete storageData[key];
  tabs = []; calls = []; alive = new Set(); sendLog = []; nextId = 100;
  keeperTimings.pollMs = 0; keeperTimings.reviveWaitMs = 0; keeperTimings.loadTimeoutMs = 50; keeperTimings.callTimeoutMs = 50;
  globalThis.fetch = (async () => Response.json({ ok: true })) as unknown as typeof fetch;
});

const creates = () => calls.filter((c) => c[0] === "create").map((c) => c[1] as any);
const reloads = () => calls.filter((c) => c[0] === "reload").map((c) => c[1]);
const keeperState = () => storageData["scrobbler.keeperTabs"] as any;
const settingsOff = { ingestBaseUrl: "http://127.0.0.1:4318", syncPeriodMinutes: 30, maxAssetBytes: 1024, autoSync: true, keepProviderTabs: false };

test("no provider tab: periodic sync creates one pinned, inactive, non-discardable keeper per provider", async () => {
  const out = await syncAll("periodic");
  expect(creates()).toEqual([
    { url: "https://chatgpt.com/", pinned: true, active: false },
    { url: "https://claude.ai/new", pinned: true, active: false },
    { url: "https://gemini.google.com/app", pinned: true, active: false },
  ]);
  expect(calls.filter((c) => c[0] === "update").map((c) => [c[1], c[2]])).toEqual([[100, { autoDiscardable: false }], [101, { autoDiscardable: false }], [102, { autoDiscardable: false }]]);
  expect(keeperState().tabs).toEqual({ chatgpt: 100, claude: 101, gemini: 102 });
  expect(out.results).toHaveLength(3);
});

test("a second periodic pass reuses the keepers and creates nothing", async () => {
  await syncAll("periodic");
  calls = [];
  await syncAll("periodic");
  expect(creates()).toEqual([]);
});

test("a keeper is re-marked non-discardable every time it is validated", async () => {
  await syncAll("periodic");
  for (const tab of tabs) tab.autoDiscardable = true;
  await syncAll("periodic");
  expect(tabs.every((t) => t.autoDiscardable === false)).toBe(true);
});

test("a keeper parked on a sign-in page is not duplicated", async () => {
  await syncAll("periodic");
  for (const tab of tabs) tab.url = "https://accounts.example.com/login";
  calls = [];
  await syncAll("periodic");
  expect(creates()).toEqual([]);
  expect(tabs).toHaveLength(3);
});

test("a closed keeper is replaced, once", async () => {
  await syncAll("periodic");
  tabs = tabs.filter((t) => t.id !== 101);
  calls = [];
  await syncAll("periodic");
  expect(creates()).toEqual([{ url: "https://claude.ai/new", pinned: true, active: false }]);
  expect(keeperState().tabs.claude).toBe(103);
});

test("existing user tabs mean no keeper is created", async () => {
  tabs = [{ id: 1, url: "https://chatgpt.com/c/a", active: true }, { id: 2, url: "https://claude.ai/chat/a" }, { id: 3, url: "https://gemini.google.com/app/a" }];
  alive = new Set([1, 2, 3]);
  await syncAll("periodic");
  expect(creates()).toEqual([]);
  expect(sendLog).toEqual([1, 2, 3]);
});

test("manual sync never opens tabs", async () => {
  await syncAll("manual");
  expect(creates()).toEqual([]);
});

test("keepProviderTabs off: no tabs created, no recovery attempted", async () => {
  storageData["scrobbler.settings"] = settingsOff;
  expect(await syncAll("periodic")).toEqual({ ok: true, results: [] });
  tabs = [{ id: 1, url: "https://chatgpt.com/", discarded: true }];
  await expect(syncAll("periodic")).rejects.toThrow("Content script not active");
  expect(calls).toEqual([]);
});

test("dead keeper is reloaded once and the sync retried", async () => {
  await syncAll("periodic");
  alive.delete(100);
  tabs.find((t) => t.id === 100)!.discarded = true;
  calls = []; sendLog = [];
  keeperState().touched.chatgpt = Date.now() - RELOAD_COOLDOWN_MS - 1;
  await syncAll("periodic");
  expect(reloads()).toEqual([100]);
  expect(sendLog.filter((id) => id === 100)).toHaveLength(2);
});

test("reload is rate limited to one per provider per 30 minutes", async () => {
  await syncAll("periodic");
  const kill = () => { tabs.find((t) => t.id === 100)!.discarded = true; alive.delete(100); };
  keeperState().touched.chatgpt = Date.now() - RELOAD_COOLDOWN_MS - 1;
  calls = [];
  kill();
  await syncAll("periodic");
  expect(reloads()).toEqual([100]);
  // dead again straight away: the cooldown blocks a second reload and the failure surfaces
  kill(); calls = [];
  await expect(syncAll("periodic")).rejects.toThrow("Content script not active");
  expect(reloads()).toEqual([]);
  // after the window it may reload again
  keeperState().touched.chatgpt = Date.now() - RELOAD_COOLDOWN_MS - 1;
  kill();
  await syncAll("periodic");
  expect(reloads()).toEqual([100]);
});

test("a freshly created keeper that does not answer is not reloaded in the same pass", async () => {
  const create = tabsApi.create;
  tabsApi.create = (props: any, cb: any) => { create(props, (t: FakeTab) => { alive.delete(t.id); cb(t); }); };
  await expect(syncAll("periodic")).rejects.toThrow("Content script not active");
  expect(reloads()).toEqual([]);
  expect(creates()).toHaveLength(3);
});

test("discarded user tab is reloaded", async () => {
  tabs = [{ id: 1, url: "https://claude.ai/chat/a", discarded: true }];
  await syncAll("manual");
  expect(reloads()).toEqual([1]);
  expect(sendLog).toEqual([1, 1]);
});

test("dead live user tab is never reloaded; the keeper is used instead", async () => {
  tabs = [{ id: 1, url: "https://chatgpt.com/c/a", active: true }];
  const out = await syncAll("periodic");
  expect(reloads()).toEqual([]);
  expect(creates().find((c) => c.url === "https://chatgpt.com/")).toEqual({ url: "https://chatgpt.com/", pinned: true, active: false });
  expect(sendLog).toContain(keeperState().tabs.chatgpt);
  expect(out.results[0].result.ok).toBe(true);
});

test("a healthy tab is preferred over a discarded one", async () => {
  tabs = [{ id: 1, url: "https://chatgpt.com/c/a", discarded: true }, { id: 2, url: "https://chatgpt.com/c/b" }];
  alive = new Set([2]);
  await syncAll("manual");
  expect(sendLog).toEqual([2]);
  expect(reloads()).toEqual([]);
});

test("missing autoDiscardable/reload/pinned support never breaks the sync", async () => {
  tabsApi.update = (_id: number, _props: any, cb: any) => { chromeStub.runtime.lastError = { message: "unsupported" }; cb(undefined); chromeStub.runtime.lastError = undefined; };
  delete tabsApi.reload;
  const create = tabsApi.create;
  tabsApi.create = (props: any, cb: any) => {
    if ("pinned" in props) throw new Error("pinned unsupported");
    create(props, cb);
  };
  await expect(syncAll("periodic")).resolves.toMatchObject({ ok: true });
  expect(tabs).toHaveLength(3);
  // dead keeper with no reload API: degrades to today's error
  alive.clear();
  await expect(syncAll("periodic")).rejects.toThrow("Content script not active");
});

test("missing tabs.get and tabs.create degrade to today's behavior", async () => {
  delete tabsApi.get;
  delete tabsApi.reload;
  delete tabsApi.create;
  tabs = [{ id: 1, url: "https://chatgpt.com/", discarded: true }];
  await expect(syncAll("periodic")).rejects.toThrow("Content script not active");
  expect(tabs).toHaveLength(1);
});

test("one failing provider does not starve the others, and the error still surfaces", async () => {
  tabs = [{ id: 1, url: "https://chatgpt.com/" }, { id: 2, url: "https://claude.ai/chat/a" }];
  alive = new Set([2]);
  storageData["scrobbler.settings"] = settingsOff;
  await expect(syncAll("manual")).rejects.toThrow("Content script not active");
  expect(sendLog).toEqual([1, 2]);
});

// Issue #77: the alarm period equals the reload cooldown, and a reload is stamped a few seconds
// after the alarm fires, so the next period lands just inside the window and was refused.
test("a user tab Chrome discards between every period is revived every period, not every other one", async () => {
  tabs = [{ id: 1, url: "https://chatgpt.com/c/a" }];
  alive = new Set([1]);
  const period = 30 * 60 * 1000;
  const realNow = Date.now;
  let skew = 0;
  Date.now = () => realNow() + skew;
  try {
    for (let cycle = 0; cycle < 4; cycle++) {
      // Chrome discards the background tab between cycles and its content script goes away.
      tabs[0].discarded = true; alive.delete(1);
      calls = [];
      const out: any = await syncAll("periodic");
      expect(out.results[0].result.ok).toBe(true);
      expect(reloads()).toEqual([1]);
      // The reload is stamped a few seconds after the alarm fired; the next alarm is one period after the alarm.
      skew += period - 3_000;
    }
  } finally { Date.now = realNow; }
});

test("a reload that does not revive the tab keeps the full cooldown, so a broken provider cannot loop", async () => {
  tabs = [{ id: 1, url: "https://gemini.google.com/app", discarded: true }];
  const period = 30 * 60 * 1000;
  const realNow = Date.now;
  let skew = 0;
  Date.now = () => realNow() + skew;
  const reload = tabsApi.reload;
  // The reload leaves the tab unanswering (e.g. redirected to a sign-in page the content script does not run on).
  tabsApi.reload = (id: number, cb: () => void) => { calls.push(["reload", id]); cb(); };
  try {
    await expect(syncAll("periodic")).rejects.toThrow("Content script not active");
    expect(reloads()).toEqual([1]);
    // The next period lands just inside the window: a reload that did not help is still throttled.
    skew += period - 3_000;
    calls = [];
    await expect(syncAll("periodic")).rejects.toThrow("Content script not active");
    expect(reloads()).toEqual([]);
    // Once the full window has passed it may try again.
    skew += 5_000;
    await expect(syncAll("periodic")).rejects.toThrow("Content script not active");
    expect(reloads()).toEqual([1]);
  } finally { Date.now = realNow; tabsApi.reload = reload; }
});

test("a revived tab is not reloaded again within the short floor", async () => {
  tabs = [{ id: 1, url: "https://chatgpt.com/c/a", discarded: true }];
  await syncAll("manual");
  expect(reloads()).toEqual([1]);
  tabs[0].discarded = true; alive.delete(1); calls = [];
  await expect(syncAll("manual")).rejects.toThrow("Content script not active");
  expect(reloads()).toEqual([]);
});

test("a content script that answers a moment after the reload is waited for, not reported dead", async () => {
  tabs = [{ id: 1, url: "https://claude.ai/chat/a", discarded: true }];
  const reload = tabsApi.reload;
  let late = 0;
  tabsApi.reload = (id: number, cb: () => void) => { calls.push(["reload", id]); tabs[0].discarded = false; late = 2; cb(); };
  const send = tabsApi.sendMessage;
  tabsApi.sendMessage = (id: number, request: any, cb: (r: unknown) => void) => {
    if (late > 0) { late--; if (late === 0) alive.add(id); }
    send(id, request, cb);
  };
  try {
    const out: any = await syncAll("manual");
    expect(out.results[0].result.ok).toBe(true);
  } finally { tabsApi.reload = reload; }
});

test("provider tabs the browser could discard are pinned down on the periodic pass", async () => {
  tabs = [{ id: 1, url: "https://chatgpt.com/c/a", autoDiscardable: true }];
  alive = new Set([1]);
  await syncAll("periodic");
  expect(tabs[0].autoDiscardable).toBe(false);
});

test("keepProviderTabs off leaves the user's tabs discardable", async () => {
  storageData["scrobbler.settings"] = settingsOff;
  tabs = [{ id: 1, url: "https://chatgpt.com/c/a", autoDiscardable: true }];
  alive = new Set([1]);
  await syncAll("periodic");
  expect(tabs[0].autoDiscardable).toBe(true);
});
