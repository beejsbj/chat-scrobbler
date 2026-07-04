// packages/extension/src/sidebar/badges.ts
// Thin DOM glue: inject a corner sync toggle into a sidebar chat link.
// All decision logic is in reconcile.ts; this only touches the DOM.
import type { ConversationState } from "./reconcile";

const BADGE_ATTR = "data-scrobbler-badge";
const CONTAINER_ATTR = "data-scrobbler-badge-container";
const STYLE_ID = "scrobbler-badge-style";

export function ensureBadgeStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .scrobbler-badge-container{position:absolute;top:3px;left:3px;
      width:14px;height:14px;display:block;pointer-events:none;z-index:1;
    }
    .scrobbler-badge{width:14px;height:14px;display:inline-flex;align-items:center;justify-content:center;
      border:0;padding:0;margin:0;border-radius:999px;background:transparent;color:inherit;
      cursor:pointer;line-height:0;pointer-events:auto;
    }
    .scrobbler-badge::before{
      content:"";width:8px;height:8px;border-radius:999px;background:currentColor;
      box-sizing:border-box;transition:background-color .2s,border-color .2s,opacity .2s,transform .2s;
    }
    .scrobbler-badge:hover::before{transform:scale(1.18);}
    .scrobbler-badge:focus-visible{outline:2px solid #0969da;outline-offset:1px;}
    .scrobbler-badge[data-state="synced"]{color:#1a7f37;}
    .scrobbler-badge[data-state="stale"]{color:#b08800;}
    .scrobbler-badge[data-state="syncing"]{color:#0969da;}
    .scrobbler-badge[data-state="syncing"]::before{animation:scrobbler-pulse 1.1s ease-in-out infinite;}
    .scrobbler-badge[data-state="error"]{color:#cf222e;}
    .scrobbler-badge[data-state="missing"]::before{background:color-mix(in srgb,currentColor 45%,transparent);}
    .scrobbler-badge[data-state="ignored"]::before{
      background:transparent;border:1.5px solid color-mix(in srgb,currentColor 48%,transparent);
    }
    @keyframes scrobbler-pulse{0%,100%{opacity:.6;transform:scale(.9);}50%{opacity:1;transform:scale(1.15);}}
  `;
  document.documentElement.appendChild(style);
}

export interface BadgeActions {
  onDelete?: () => void;
  onToggle?: () => void;
}

/** Create-or-update the badge on a sidebar anchor. Idempotent. */
export function setBadge(anchor: Element, state: ConversationState, actions: BadgeActions = {}): void {
  ensureAnchorPosition(anchor);
  const container = ensureContainer(anchor);
  const badge = ensureBadge(container);
  const label = dotLabel(state);
  const onActivate = activationForState(state, actions);

  badge.dataset.state = state;
  badge.title = label;
  badge.setAttribute("aria-label", label);
  badge.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    onActivate?.();
  };
}

function ensureContainer(anchor: Element): HTMLElement {
  let container = anchor.querySelector(`[${CONTAINER_ATTR}]`) as HTMLElement | null;
  if (!container) {
    container = document.createElement("span");
    container.setAttribute(CONTAINER_ATTR, "1");
    container.className = "scrobbler-badge-container";
    container.style.position = "absolute";
    container.style.top = "3px";
    container.style.left = "3px";
    anchor.appendChild(container);
  }
  return container;
}

function ensureBadge(container: HTMLElement): HTMLButtonElement {
  let badge = container.querySelector(`[${BADGE_ATTR}]`) as HTMLButtonElement | null;
  if (!badge) {
    badge = document.createElement("button");
    badge.type = "button";
    badge.setAttribute(BADGE_ATTR, "1");
    badge.className = "scrobbler-badge";
    container.appendChild(badge);
  }
  return badge;
}

function ensureAnchorPosition(anchor: Element): void {
  const styledAnchor = anchor as HTMLElement & { style?: CSSStyleDeclaration };
  if (!styledAnchor.style) return;
  if (getComputedStyle(anchor).position === "static") styledAnchor.style.position = "relative";
}

function activationForState(state: ConversationState, actions: BadgeActions): (() => void) | undefined {
  if (state === "ignored" || state === "missing") return actions.onToggle;
  return actions.onDelete;
}

function dotLabel(state: ConversationState): string {
  if (state === "ignored") return "Not syncing. Click to re-enable";
  if (state === "missing") return "Not captured. Click to stop syncing";
  return "Captured. Click to delete and stop syncing";
}
