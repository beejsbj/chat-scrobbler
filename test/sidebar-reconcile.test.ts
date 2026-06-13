// test/sidebar-reconcile.test.ts
import { test, expect } from "bun:test";
import {
  CAPTURE_RETRY_DELAY_MS,
  CAPTURE_THROTTLE_MS,
  DEFAULT_RATE_LIMIT_COOLDOWN_MS,
  FAST_PATH_DEBOUNCE_MS,
  FULL_RECONCILE_MIN_INTERVAL_MS,
  MAX_RATE_LIMIT_COOLDOWN_MS,
  SIDEBAR_CONFIGS,
  activeConversationId,
  badgePresentation,
  captureDelayMs,
  captureQueue,
  captureWithRetry,
  nextCooldownMs,
  nextFullReconcileDelayMs,
  shouldRecapture,
} from "../packages/extension/src/sidebar/reconcile";

test("idFromHref pulls the conversation id per provider", () => {
  expect(SIDEBAR_CONFIGS.claude.idFromHref("/chat/fa590fac-5b92-446c-ad5d-cb3197b92caa")).toBe("fa590fac-5b92-446c-ad5d-cb3197b92caa");
  expect(SIDEBAR_CONFIGS.chatgpt.idFromHref("https://chatgpt.com/c/6a1b9f5c-eaac-83ea")).toBe("6a1b9f5c-eaac-83ea");
  expect(SIDEBAR_CONFIGS.chatgpt.idFromHref("c/6a1b9f5c-eaac-83ea?model=gpt-4o")).toBe("6a1b9f5c-eaac-83ea");
  expect(SIDEBAR_CONFIGS.gemini.idFromHref("/app/abc123def4567890")).toBe("abc123def4567890");
  expect(SIDEBAR_CONFIGS.gemini.idFromHref("app/abc123def4567890?hl=en")).toBe("abc123def4567890");
  expect(SIDEBAR_CONFIGS.gemini.idFromHref("/app/new")).toBeNull();
  expect(SIDEBAR_CONFIGS.gemini.idFromHref("/app/settings")).toBeNull();
  expect(SIDEBAR_CONFIGS.claude.idFromHref("/settings/profile")).toBeNull();
});

test("sidebar link selectors include provider-specific fallbacks", () => {
  expect(SIDEBAR_CONFIGS.chatgpt.linkSelector).toContain('aside a[href*="/c/"]');
  expect(SIDEBAR_CONFIGS.gemini.linkSelector).toContain('a[href^="/app/"]');
});

test("badgePresentation maps each state to a glyph + accessible label", () => {
  // Glyphs are now inline SVG strings; verify they are non-empty SVG and that
  // state + label contracts are upheld (exact markup is an implementation detail).
  const synced = badgePresentation("synced");
  expect(synced.state).toBe("synced");
  expect(synced.glyph).toContain("<svg");
  expect(synced.label).toMatch(/synced/i);

  const missing = badgePresentation("missing");
  expect(missing.state).toBe("missing");
  expect(missing.glyph).toContain("<svg");
  expect(missing.label).toMatch(/not synced/i);

  const syncing = badgePresentation("syncing");
  expect(syncing.state).toBe("syncing");
  expect(syncing.glyph).toContain("<svg");
  expect(syncing.label).toMatch(/syncing/i);

  const stale = badgePresentation("stale");
  expect(stale.state).toBe("stale");
  expect(stale.glyph).toContain("<svg");

  const error = badgePresentation("error");
  expect(error.state).toBe("error");
  expect(error.glyph).toContain("<svg");
});

test("captureQueue selects missing+stale in order, only when auto-sync is on", () => {
  const statuses = { a: "synced", b: "missing", c: "stale", d: "synced" } as const;
  const ids = ["a", "b", "c", "d"];
  expect(captureQueue(statuses, ids, true)).toEqual(["b", "c"]);
  expect(captureQueue(statuses, ids, false)).toEqual([]);
});

test("captureDelayMs inserts a throttle only between captures", () => {
  expect(captureDelayMs(0)).toBe(0);
  expect(captureDelayMs(1)).toBe(CAPTURE_THROTTLE_MS);
  expect(captureDelayMs(2, 100)).toBe(100);
});

test("nextCooldownMs respects retry-after and grows capped defaults", () => {
  expect(nextCooldownMs(1)).toBe(DEFAULT_RATE_LIMIT_COOLDOWN_MS);
  expect(nextCooldownMs(2)).toBe(DEFAULT_RATE_LIMIT_COOLDOWN_MS * 2);
  expect(nextCooldownMs(20)).toBe(MAX_RATE_LIMIT_COOLDOWN_MS);
  expect(nextCooldownMs(1, 2_500)).toBe(2_500);
  expect(nextCooldownMs(1, MAX_RATE_LIMIT_COOLDOWN_MS * 2)).toBe(MAX_RATE_LIMIT_COOLDOWN_MS);
});

test("nextFullReconcileDelayMs enforces min interval and retry cooldown", () => {
  expect(nextFullReconcileDelayMs(10_000, null, 0)).toBe(0);
  expect(nextFullReconcileDelayMs(10_000, 0, 0)).toBe(FULL_RECONCILE_MIN_INTERVAL_MS - 10_000);
  expect(nextFullReconcileDelayMs(20_000, 0, 0)).toBe(0);
  expect(nextFullReconcileDelayMs(20_000, 0, 70_000)).toBe(50_000);
});

test("captureWithRetry resolves on first success without retrying", async () => {
  let attemptCount = 0;
  const attempt = async () => { attemptCount++; };
  await captureWithRetry(attempt, { isRateLimit: () => false });
  expect(attemptCount).toBe(1);
});

test("captureWithRetry retries once after a transient failure then succeeds", async () => {
  let attemptCount = 0;
  let waitCount = 0;
  let lastWaitMs = 0;
  const attempt = async () => {
    attemptCount++;
    if (attemptCount === 1) throw new Error("transient error");
  };
  const wait = async (ms: number) => { waitCount++; lastWaitMs = ms; };
  await captureWithRetry(attempt, {
    isRateLimit: () => false,
    wait,
    delayMs: CAPTURE_RETRY_DELAY_MS,
    retries: 1,
  });
  expect(attemptCount).toBe(2);
  expect(waitCount).toBe(1);
  expect(lastWaitMs).toBe(CAPTURE_RETRY_DELAY_MS);
});

test("captureWithRetry rethrows a rate-limit error without retrying", async () => {
  let attemptCount = 0;
  const rateLimitError = new Error("rate limit");
  const attempt = async () => { attemptCount++; throw rateLimitError; };
  try {
    await captureWithRetry(attempt, {
      isRateLimit: (e) => e === rateLimitError,
    });
    expect(false).toBe(true); // should not reach here
  } catch (e) {
    expect(e).toBe(rateLimitError);
    expect(attemptCount).toBe(1);
  }
});

test("captureWithRetry rethrows after exhausting retries", async () => {
  let attemptCount = 0;
  const transientError = new Error("transient");
  const attempt = async () => { attemptCount++; throw transientError; };
  try {
    await captureWithRetry(attempt, {
      isRateLimit: () => false,
      retries: 1,
    });
    expect(false).toBe(true); // should not reach here
  } catch (e) {
    expect(e).toBe(transientError);
    expect(attemptCount).toBe(2); // 1 initial + 1 retry
  }
});

// ---- shouldRecapture ----

test("shouldRecapture returns true when chat was never captured (undefined)", () => {
  expect(shouldRecapture(undefined, 1_000)).toBe(true);
});

test("shouldRecapture returns false when live updatedAt equals last-captured value", () => {
  expect(shouldRecapture(1_000, 1_000)).toBe(false);
});

test("shouldRecapture returns false when live updatedAt is older than last-captured value", () => {
  expect(shouldRecapture(2_000, 1_000)).toBe(false);
});

test("shouldRecapture returns true when live updatedAt is strictly newer than last captured", () => {
  expect(shouldRecapture(1_000, 2_000)).toBe(true);
});

test("shouldRecapture treats null live updatedAt as epoch (0) and skips if already captured at 0", () => {
  // null is coerced to 0 by the caller in index.ts; test the helper directly
  expect(shouldRecapture(0, 0)).toBe(false);
});

test("shouldRecapture returns true when captured at 0 (null) but live is now non-zero", () => {
  expect(shouldRecapture(0, 500)).toBe(true);
});

// ---- activeConversationId ----

test("FAST_PATH_DEBOUNCE_MS is 1500 ms", () => {
  expect(FAST_PATH_DEBOUNCE_MS).toBe(1_500);
});

test("activeConversationId extracts chat id from a full Claude URL", () => {
  expect(activeConversationId(
    "https://claude.ai/chat/fa590fac-5b92-446c-ad5d-cb3197b92caa",
    SIDEBAR_CONFIGS.claude,
  )).toBe("fa590fac-5b92-446c-ad5d-cb3197b92caa");
});

test("activeConversationId extracts chat id from a full ChatGPT URL", () => {
  expect(activeConversationId(
    "https://chatgpt.com/c/6a1b9f5c-eaac-83ea",
    SIDEBAR_CONFIGS.chatgpt,
  )).toBe("6a1b9f5c-eaac-83ea");
});

test("activeConversationId extracts chat id from a full Gemini URL", () => {
  expect(activeConversationId(
    "https://gemini.google.com/app/abc123def4567890",
    SIDEBAR_CONFIGS.gemini,
  )).toBe("abc123def4567890");
});

test("activeConversationId falls back to raw-path parsing when href is a pathname", () => {
  // Simulates tests or environments where location.href is already a pathname.
  expect(activeConversationId(
    "/chat/fa590fac-5b92-446c-ad5d-cb3197b92caa",
    SIDEBAR_CONFIGS.claude,
  )).toBe("fa590fac-5b92-446c-ad5d-cb3197b92caa");
});

test("activeConversationId returns null on a non-conversation page (settings)", () => {
  expect(activeConversationId(
    "https://claude.ai/settings/profile",
    SIDEBAR_CONFIGS.claude,
  )).toBeNull();
});

test("activeConversationId returns null on the Gemini landing page (/app/new)", () => {
  expect(activeConversationId(
    "https://gemini.google.com/app/new",
    SIDEBAR_CONFIGS.gemini,
  )).toBeNull();
});

test("activeConversationId returns null for the provider home page (no chat segment)", () => {
  expect(activeConversationId(
    "https://chatgpt.com/",
    SIDEBAR_CONFIGS.chatgpt,
  )).toBeNull();
});
