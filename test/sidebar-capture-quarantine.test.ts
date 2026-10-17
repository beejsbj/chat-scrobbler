// test/sidebar-capture-quarantine.test.ts
// Drives runSidebarBadges against a fake DOM, fake timers and a fake clock to prove the
// reconcile loop and the active-chat fast pass stop re-capturing a chat that keeps failing.
import { afterEach, expect, test } from "bun:test";
import { runSidebarBadges, type SidebarDeps } from "../packages/extension/src/sidebar/index";
import { CAPTURE_FAILURE_BACKOFF_MS, FULL_RECONCILE_MIN_INTERVAL_MS } from "../packages/extension/src/sidebar/reconcile";
import type { ProviderAdapter } from "../packages/extension/src/providers";

const CHAT_ID = "abc123def4567890";

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  className = "";
  id = "";
  title = "";
  type = "";
  textContent = "";
  onclick: unknown = null;
  private readonly attrs = new Map<string, string>();
  constructor(readonly tagName: string) {}
  appendChild(child: FakeElement): FakeElement { this.children.push(child); return child; }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
  querySelector(selector: string): FakeElement | null {
    const attr = selector.match(/^\[([^\]=]+)\]$/)?.[1];
    for (const child of this.children) {
      if (attr && child.attrs.has(attr)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
}

interface FakeTimer { id: number; fn: () => void; at: number }

const saved = {
  document: (globalThis as Record<string, unknown>).document,
  location: (globalThis as Record<string, unknown>).location,
  MutationObserver: (globalThis as Record<string, unknown>).MutationObserver,
  getComputedStyle: (globalThis as Record<string, unknown>).getComputedStyle,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  now: Date.now,
};

afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  g.document = saved.document;
  g.location = saved.location;
  g.MutationObserver = saved.MutationObserver;
  g.getComputedStyle = saved.getComputedStyle;
  globalThis.setTimeout = saved.setTimeout;
  globalThis.clearTimeout = saved.clearTimeout;
  Date.now = saved.now;
});

function installFakes() {
  let now = 1_000_000;
  let nextId = 1;
  let timers: FakeTimer[] = [];
  let observerCallback: (() => void) | null = null;

  const anchor = new FakeElement("a");
  anchor.setAttribute("href", `/app/${CHAT_ID}`);
  const g = globalThis as Record<string, unknown>;
  g.document = {
    querySelectorAll: () => [anchor],
    getElementById: () => null,
    createElement: (tag: string) => new FakeElement(tag),
    documentElement: new FakeElement("html"),
    body: new FakeElement("body"),
  };
  g.location = { href: `https://gemini.google.com/app/${CHAT_ID}` };
  g.getComputedStyle = () => ({ position: "relative" });
  g.MutationObserver = class {
    constructor(callback: () => void) { observerCallback = callback; }
    observe(): void {}
    disconnect(): void {}
  };
  Date.now = () => now;
  globalThis.setTimeout = ((fn: () => void, ms = 0) => {
    const id = nextId++;
    timers.push({ id, fn, at: now + Math.max(0, ms) });
    return id;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => { timers = timers.filter((t) => t.id !== id); }) as typeof clearTimeout;

  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

  /** Advance the fake clock, firing due timers in order and letting their promises settle. */
  async function advance(ms: number): Promise<void> {
    const target = now + ms;
    for (let guard = 0; guard < 1_000; guard++) {
      for (let i = 0; i < 20; i++) await settle();
      const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter((t) => t !== due);
      now = Math.max(now, due.at);
      due.fn();
    }
    now = target;
    for (let i = 0; i < 20; i++) await settle();
  }

  return {
    advance,
    mutate: () => observerCallback?.(),
    badgeState: () => anchor.querySelector("[data-scrobbler-badge]")?.dataset.state,
  };
}

function failingProvider(updatedAt: { value: string }) {
  let calls = 0;
  const provider = {
    source: "gemini",
    listConversations: async () => [{ id: CHAT_ID, updatedAt: updatedAt.value }],
    captureOne: async () => { calls++; throw new Error("capture failed"); },
  } as unknown as ProviderAdapter;
  return { provider, calls: () => calls };
}

const deps: SidebarDeps = {
  getStates: async () => ({ [CHAT_ID]: "missing" }),
  getAutoSync: async () => true,
  getIgnoredIds: async () => new Set<string>(),
  toggleIgnored: async () => false,
  deleteCapture: async () => {},
  emitCapture: async () => {},
};

test("a chat whose capture keeps failing is not retried by reconcile or the fast pass until its backoff elapses", async () => {
  const fakes = installFakes();
  const updatedAt = { value: "2026-10-17T00:00:00Z" };
  const { provider, calls } = failingProvider(updatedAt);

  runSidebarBadges(provider, deps);
  await fakes.advance(1_000);
  // One reconcile attempt plus captureWithRetry's single transient retry.
  expect(calls()).toBe(2);
  expect(fakes.badgeState()).toBe("error");

  // Several DOM mutations later, past the reconcile min interval, nothing is re-fetched.
  for (let i = 0; i < 5; i++) {
    fakes.mutate();
    await fakes.advance(FULL_RECONCILE_MIN_INTERVAL_MS + 1_000);
  }
  expect(calls()).toBe(2);
  expect(fakes.badgeState()).toBe("error");

  // Once the backoff elapses, the chat gets one more attempt.
  await fakes.advance(CAPTURE_FAILURE_BACKOFF_MS);
  fakes.mutate();
  await fakes.advance(FULL_RECONCILE_MIN_INTERVAL_MS + 1_000);
  expect(calls()).toBe(4);
});

test("new activity in a quarantined chat lifts the quarantine immediately", async () => {
  const fakes = installFakes();
  const updatedAt = { value: "2026-10-17T00:00:00Z" };
  const { provider, calls } = failingProvider(updatedAt);

  runSidebarBadges(provider, deps);
  await fakes.advance(1_000);
  expect(calls()).toBe(2);

  updatedAt.value = "2026-10-17T00:05:00Z";
  fakes.mutate();
  await fakes.advance(FULL_RECONCILE_MIN_INTERVAL_MS + 1_000);
  expect(calls()).toBeGreaterThan(2);
});
