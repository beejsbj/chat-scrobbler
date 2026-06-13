// packages/extension/src/sidebar/index.ts
// Orchestrates the in-page sidebar badges (runs in the content-script world):
// read visible chats -> ask the spine for their state -> paint badges ->
// auto-capture the not-yet-synced ones one at a time so the user watches them
// flip. Re-runs (debounced) when the sidebar mutates.
import {
  CAPTURE_RETRY_DELAY_MS,
  FAST_PATH_DEBOUNCE_MS,
  SIDEBAR_CONFIGS,
  activeConversationId,
  captureDelayMs,
  captureQueue,
  captureWithRetry,
  nextCooldownMs,
  nextFullReconcileDelayMs,
  shouldRecapture,
  type ConversationState,
} from "./reconcile";
import { ensureBadgeStyles, setBadge } from "./badges";
import { isRateLimitError, type ProviderAdapter } from "../providers";
import type { RawCapture } from "../../../shared/src";
import { cleanTitle, type CaptureKind } from "../recent-captures";

const SIDEBAR_RECONCILE_DEBOUNCE_MS = 800;

export interface SidebarDeps {
  getStates: (conversations: Array<{ id: string; updatedAt: string | null }>) => Promise<Record<string, ConversationState>>;
  getAutoSync: () => Promise<boolean>;
  emitCapture: (capture: RawCapture) => Promise<void>;
  reportCaptureProgress?: (remaining: number, total: number) => Promise<void> | void;
  /** Called after each successful capture with the id, human-readable title, and capture kind. */
  onCaptured?: (id: string, title: string, kind: CaptureKind) => void;
}

export function runSidebarBadges(provider: ProviderAdapter, deps: SidebarDeps): void {
  const config = SIDEBAR_CONFIGS[provider.source];
  ensureBadgeStyles();

  const collectAnchors = (): Map<string, Element> => {
    const map = new Map<string, Element>();
    for (const a of Array.from(document.querySelectorAll(config.linkSelector))) {
      const id = config.idFromHref(a.getAttribute("href") || "");
      if (id && !map.has(id)) map.set(id, a);
    }
    return map;
  };

  let running = false;
  let fastPathTimer: ReturnType<typeof setTimeout> | undefined;
  const observer = new MutationObserver(() => { schedule(); scheduleFastPath(); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastFullRunAtMs: number | null = null;
  let retryAfterUntilMs = 0;
  let rateLimitAttempts = 0;
  let cachedStatuses: Record<string, ConversationState> = {};
  /**
   * Session-scoped re-capture guard: maps conversation id -> updatedAt (ms) at
   * which we last successfully captured it. Prevents endless re-capture churn
   * when /status keeps reporting a conversation as "missing" or "stale" due to
   * id mismatches (e.g. Gemini live /app/<hex> vs Takeout source_ids). We only
   * re-capture if the live updatedAt has advanced since our last capture.
   */
  const lastCapturedAt = new Map<string, number>();

  const schedule = (delayMs = SIDEBAR_RECONCILE_DEBOUNCE_MS): void => {
    clearTimeout(timer);
    timer = setTimeout(() => { void reconcile(); }, Math.max(0, delayMs));
  };

  const scheduleFastPath = (): void => {
    // Only arm the fast path when the current page URL matches a conversation.
    const activeId = activeConversationId(location.href, config);
    if (!activeId) return;
    clearTimeout(fastPathTimer);
    fastPathTimer = setTimeout(() => { void activeFastPass(activeId); }, FAST_PATH_DEBOUNCE_MS);
  };

  async function reconcile(): Promise<void> {
    if (running) return;
    running = true;
    let progressStarted = false;
    let progressTotal = 0;
    observer.disconnect(); // ignore our own badge mutations while we work
    try {
      const anchors = collectAnchors();
      if (anchors.size === 0) return;
      const nextFullDelayMs = nextFullReconcileDelayMs(Date.now(), lastFullRunAtMs, retryAfterUntilMs);
      if (nextFullDelayMs > 0) {
        paintCachedStatuses(anchors);
        schedule(nextFullDelayMs);
        return;
      }

      lastFullRunAtMs = Date.now();

      // The DOM lacks timestamps; the provider list API supplies updatedAt.
      let updatedById = new Map<string, string | null>();
      try {
        const summaries = provider.listConversations ? await provider.listConversations(1) : [];
        updatedById = new Map(summaries.map((s) => [s.id, s.updatedAt]));
      } catch (error) {
        if (isRateLimitError(error)) {
          scheduleRateLimitRetry(error);
          paintCachedStatuses(anchors);
          return;
        }
        /* fall back to id-only status */
      }

      const ids = [...anchors.keys()];
      const visible = ids.map((id) => ({ id, updatedAt: updatedById.get(id) ?? null }));

      let statuses: Record<string, ConversationState> = {};
      try { statuses = await deps.getStates(visible); } catch { return; }
      cachedStatuses = { ...statuses };
      for (const [id, anchor] of anchors) setBadge(anchor, statuses[id] ?? "missing");

      const autoSync = await deps.getAutoSync().catch(() => false);
      // Apply the session-scoped re-capture guard AFTER captureQueue so captureQueue
      // itself stays pure. We skip any id we already captured this page-session
      // unless its live updatedAt has advanced since our last capture. This prevents
      // endless re-capture churn from /status id-mismatch false-positives (e.g.
      // Gemini live /app/<hex> never matching Takeout source_ids).
      const fullQueue = captureQueue(statuses, ids, autoSync);
      const queue = fullQueue.filter((id) => {
        const liveMs = updatedById.has(id)
          ? (updatedById.get(id) ? Date.parse(updatedById.get(id)!) : 0)
          : 0;
        return shouldRecapture(lastCapturedAt.get(id), liveMs);
      });
      progressTotal = queue.length;
      if (progressTotal > 0) {
        progressStarted = true;
        await reportCaptureProgress(progressTotal, progressTotal);
      }
      let remaining = progressTotal;
      let stoppedByRateLimit = false;
      for (let index = 0; index < queue.length; index++) {
        const id = queue[index]!;
        const anchor = anchors.get(id);
        if (!provider.captureOne) break;
        await wait(captureDelayMs(index));
        if (anchor) setBadge(anchor, "syncing");
        try {
          await captureWithRetry(
            () => provider.captureOne!(id, updatedById.get(id) ?? null, deps.emitCapture),
            { isRateLimit: isRateLimitError, wait, delayMs: CAPTURE_RETRY_DELAY_MS },
          );
          // Record the updatedAt we just captured so we don't re-capture this same
          // version on the next reconcile cycle.
          const capturedAtMs = updatedById.has(id)
            ? (updatedById.get(id) ? Date.parse(updatedById.get(id)!) : 0)
            : 0;
          lastCapturedAt.set(id, capturedAtMs);
          // Determine kind from the pre-capture status: "missing" = brand-new chat,
          // anything else ("stale") = update to an existing one.
          const kind: CaptureKind = statuses[id] === "missing" ? "new" : "update";
          cachedStatuses[id] = "synced";
          if (anchor) setBadge(anchor, cachedStatuses[id]);
          // Notify the background so the popup "captured this session" list updates.
          if (deps.onCaptured) {
            deps.onCaptured(id, anchor ? anchorTitle(anchor) : id, kind);
          }
        } catch (error) {
          if (isRateLimitError(error)) {
            stoppedByRateLimit = true;
            cachedStatuses[id] = "missing";
            if (anchor) setBadge(anchor, cachedStatuses[id]);
            scheduleRateLimitRetry(error);
          } else {
            cachedStatuses[id] = "error";
            if (anchor) setBadge(anchor, cachedStatuses[id]);
          }
        } finally {
          remaining = Math.max(0, remaining - 1);
          await reportCaptureProgress(remaining, progressTotal);
        }
        if (stoppedByRateLimit) break;
      }
      if (!stoppedByRateLimit) {
        rateLimitAttempts = 0;
        retryAfterUntilMs = 0;
      }
    } finally {
      if (progressStarted) await reportCaptureProgress(0, progressTotal);
      running = false;
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  /**
   * Active-chat fast path: targeted single-conversation capture triggered by the
   * MutationObserver debounce.  Runs only when the full reconcile is not already
   * running (shared `running` lock), reuses the same shouldRecapture + lastCapturedAt
   * guard, and paints badges identically to the main loop.
   */
  async function activeFastPass(activeId: string): Promise<void> {
    // Skip if locked (full reconcile in progress) or rate-limited.
    if (running) return;
    if (Date.now() < retryAfterUntilMs) return;
    if (!provider.captureOne) return;

    running = true;
    observer.disconnect();
    try {
      const anchors = collectAnchors();
      const anchor = anchors.get(activeId);

      // Fetch a fresh updatedAt for this one conversation from the provider.
      let liveUpdatedAt: string | null = null;
      try {
        if (provider.listConversations) {
          const summaries = await provider.listConversations(1);
          const match = summaries.find((s) => s.id === activeId);
          if (match) liveUpdatedAt = match.updatedAt;
        }
      } catch (error) {
        if (isRateLimitError(error)) { scheduleRateLimitRetry(error); return; }
        // If we can't get updatedAt, proceed with null (shouldRecapture will allow first-time captures).
      }

      const liveMs = liveUpdatedAt ? Date.parse(liveUpdatedAt) : 0;
      if (!shouldRecapture(lastCapturedAt.get(activeId), liveMs)) return;

      // Optimistic paint: immediate "syncing" feedback before the network call.
      if (anchor) setBadge(anchor, "syncing");

      try {
        await captureWithRetry(
          () => provider.captureOne!(activeId, liveUpdatedAt, deps.emitCapture),
          { isRateLimit: isRateLimitError, wait, delayMs: CAPTURE_RETRY_DELAY_MS },
        );
        lastCapturedAt.set(activeId, liveMs);
        // Fast-path kind heuristic: a brand-new chat has no prior lastCapturedAt
        // entry AND no cached status (or a "missing" cached status). Everything
        // else is an update to a chat we've seen before.
        const fastKind: CaptureKind =
          !lastCapturedAt.has(activeId) &&
          (cachedStatuses[activeId] === undefined || cachedStatuses[activeId] === "missing")
            ? "new"
            : "update";
        cachedStatuses[activeId] = "synced";
        if (anchor) setBadge(anchor, "synced");
        if (deps.onCaptured) {
          deps.onCaptured(activeId, anchor ? anchorTitle(anchor) : activeId, fastKind);
        }
      } catch (error) {
        if (isRateLimitError(error)) {
          cachedStatuses[activeId] = "missing";
          if (anchor) setBadge(anchor, "missing");
          scheduleRateLimitRetry(error);
        } else {
          cachedStatuses[activeId] = "error";
          if (anchor) setBadge(anchor, "error");
        }
      }
    } finally {
      running = false;
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  async function reportCaptureProgress(remaining: number, total: number): Promise<void> {
    try { await deps.reportCaptureProgress?.(remaining, total); } catch { /* ignore toolbar progress failures */ }
  }

  function paintCachedStatuses(anchors: Map<string, Element>): void {
    for (const [id, anchor] of anchors) setBadge(anchor, cachedStatuses[id] ?? "missing");
  }

  function scheduleRateLimitRetry(error: unknown): void {
    const retryAfterMs = isRateLimitError(error) ? error.retryAfterMs : null;
    rateLimitAttempts += 1;
    const cooldownMs = nextCooldownMs(rateLimitAttempts, retryAfterMs);
    retryAfterUntilMs = Date.now() + cooldownMs;
    schedule(cooldownMs);
  }

  void reconcile();
}

/** Extract a human-readable title from a sidebar anchor element.
 *  Clones the anchor, strips the scrobbler badge node (which has no visible
 *  text but may produce whitespace), then returns the cleaned textContent. */
function anchorTitle(anchor: Element): string {
  const clone = anchor.cloneNode(true) as Element;
  const badge = clone.querySelector("[data-scrobbler-badge]");
  if (badge) badge.remove();
  return cleanTitle(clone.textContent ?? "");
}

function wait(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
