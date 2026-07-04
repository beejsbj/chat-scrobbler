// packages/extension/src/sidebar/badges.ts
// Thin DOM glue: inject a left-edge sync toggle into a sidebar chat link.
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
    .scrobbler-badge-container{position:absolute;left:0;top:0;bottom:0;width:8px;
      display:block;pointer-events:none;z-index:1;
    }
    .scrobbler-badge{position:absolute;left:0;top:0;bottom:0;width:8px;
      display:block;border:0;padding:0;margin:0;background:transparent;color:inherit;
      cursor:pointer;line-height:0;pointer-events:auto;
    }
    .scrobbler-badge::before{
      content:"";position:absolute;left:0;top:0;bottom:0;width:3px;
      border-radius:0;background:currentColor;opacity:1;box-sizing:border-box;
      transition:background-color .2s,opacity .2s,width .2s;
    }
    .scrobbler-badge:hover::before{opacity:1;width:4px;}
    .scrobbler-badge:focus-visible{outline:2px solid #0969da;outline-offset:1px;}
    .scrobbler-badge[data-state="synced"]{color:#1a7f37;}
    .scrobbler-badge[data-state="stale"]{color:#b08800;}
    .scrobbler-badge[data-state="syncing"]{color:#0969da;}
    .scrobbler-badge[data-state="syncing"]::before{animation:scrobbler-pulse 1.1s ease-in-out infinite;}
    .scrobbler-badge:hover[data-state="syncing"]::before{animation:none;}
    .scrobbler-badge[data-state="error"]{color:#cf222e;}
    .scrobbler-badge[data-state="missing"]::before{opacity:.4;}
    .scrobbler-badge[data-state="ignored"]::before{opacity:.4;}
    @keyframes scrobbler-pulse{0%,100%{opacity:.65;}50%{opacity:1;}}
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
  const label = barLabel(state);
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
    container.style.left = "0";
    container.style.top = "0";
    container.style.bottom = "0";
    container.style.width = "8px";
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

function barLabel(state: ConversationState): string {
  if (state === "ignored" || state === "missing") return "Not syncing. Click to re-enable";
  return "Captured. Click to delete and stop syncing";
}
