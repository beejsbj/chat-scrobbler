// packages/extension/src/sidebar/badges.ts
// Thin DOM glue: inject an iCloud-style sync glyph next to a sidebar chat link.
// All decision logic is in reconcile.ts; this only touches the DOM.
import { badgePresentation, type ConversationState } from "./reconcile";

const BADGE_ATTR = "data-scrobbler-badge";
const STYLE_ID = "scrobbler-badge-style";

export function ensureBadgeStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .scrobbler-badge{
      display:inline-flex;align-items:center;justify-content:center;
      width:10px;height:10px;margin-left:5px;
      vertical-align:middle;flex:0 0 auto;
      transition:color .2s,opacity .2s;pointer-events:auto;
      line-height:0;
    }
    .scrobbler-badge svg{display:block;width:10px;height:10px;}
    .scrobbler-badge[data-state="synced"]{color:#1a7f37;}
    .scrobbler-badge[data-state="stale"]{color:#b08800;}
    .scrobbler-badge[data-state="syncing"]{color:#0969da;}
    .scrobbler-badge[data-state="syncing"] svg{animation:scrobbler-spin .9s linear infinite;}
    .scrobbler-badge[data-state="error"]{color:#cf222e;}
    .scrobbler-badge[data-state="missing"]{color:#9aa0a6;opacity:.55;}
    .scrobbler-badge[data-state="ignored"]{color:#6e7781;opacity:.8;}
    @keyframes scrobbler-spin{to{transform:rotate(360deg);}}
  `;
  document.documentElement.appendChild(style);
}

/** Create-or-update the badge on a sidebar anchor. Idempotent. */
export function setBadge(anchor: Element, state: ConversationState, onToggle?: () => void): void {
  const pres = badgePresentation(state);
  let badge = anchor.querySelector(`[${BADGE_ATTR}]`) as HTMLElement | null;
  if (!badge) {
    badge = document.createElement("span");
    badge.setAttribute(BADGE_ATTR, "1");
    badge.className = "scrobbler-badge";
    badge.setAttribute("role", "button");
    badge.setAttribute("tabindex", "0");
    anchor.appendChild(badge);
  }
  badge.dataset.state = pres.state;
  badge.innerHTML = pres.glyph;
  badge.title = `Chat history: ${pres.label}`;
  badge.setAttribute("aria-label", badge.title);
  badge.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    onToggle?.();
  };
  badge.onkeydown = (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    onToggle?.();
  };
}
