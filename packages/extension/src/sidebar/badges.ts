// packages/extension/src/sidebar/badges.ts
// Thin DOM glue: inject an iCloud-style sync glyph next to a sidebar chat link.
// All decision logic is in reconcile.ts; this only touches the DOM.
import { badgeActionLabel, badgePresentation, deleteActionLabel, type ConversationState } from "./reconcile";

const BADGE_ATTR = "data-scrobbler-badge";
const ACTIONS_ATTR = "data-scrobbler-actions";
const STYLE_ID = "scrobbler-badge-style";
const DELETE_ACTION_ATTR = "data-scrobbler-delete";
const TOGGLE_ACTION_ATTR = "data-scrobbler-toggle";

export function ensureBadgeStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .scrobbler-actions{
      display:inline-flex;align-items:center;gap:4px;margin-left:5px;
      vertical-align:middle;flex:0 0 auto;pointer-events:auto;
    }
    .scrobbler-badge{
      display:inline-flex;align-items:center;justify-content:center;
      width:10px;height:10px;
      vertical-align:middle;flex:0 0 auto;
      transition:color .2s,opacity .2s;pointer-events:none;
      line-height:0;
    }
    .scrobbler-badge svg{display:block;width:10px;height:10px;}
    .scrobbler-action{
      display:inline-flex;align-items:center;justify-content:center;
      width:14px;height:14px;border:0;padding:0;margin:0;border-radius:3px;
      color:#6e7781;background:transparent;cursor:pointer;line-height:0;
    }
    .scrobbler-action svg{display:block;width:12px;height:12px;}
    .scrobbler-action:hover{color:#24292f;background:rgba(175,184,193,.2);}
    .scrobbler-action:focus-visible{outline:2px solid #0969da;outline-offset:1px;}
    .scrobbler-action[data-kind="delete"]:hover{color:#cf222e;}
    .scrobbler-action[aria-pressed="true"]{color:#6e7781;background:rgba(175,184,193,.24);}
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

export interface BadgeActions {
  onDelete?: () => void;
  onToggle?: () => void;
}

/** Create-or-update the badge on a sidebar anchor. Idempotent. */
export function setBadge(anchor: Element, state: ConversationState, actions: BadgeActions = {}): void {
  const pres = badgePresentation(state);
  const container = ensureContainer(anchor);
  const badge = ensureBadge(container);
  const deleteButton = ensureAction(container, DELETE_ACTION_ATTR, "delete");
  const toggleButton = ensureAction(container, TOGGLE_ACTION_ATTR, "toggle");

  badge.dataset.state = pres.state;
  badge.innerHTML = pres.glyph;
  badge.title = pres.label;
  badge.setAttribute("aria-label", pres.label);

  wireAction(deleteButton, deleteActionLabel(), undefined, actions.onDelete);
  deleteButton.innerHTML = trashGlyph();

  const toggleLabel = badgeActionLabel(state);
  wireAction(toggleButton, toggleLabel, state === "ignored", actions.onToggle);
  toggleButton.innerHTML = state === "ignored" ? enableSyncGlyph() : disableSyncGlyph();
}

function ensureContainer(anchor: Element): HTMLElement {
  let container = anchor.querySelector(`[${ACTIONS_ATTR}]`) as HTMLElement | null;
  if (!container) {
    container = document.createElement("span");
    container.setAttribute(ACTIONS_ATTR, "1");
    container.className = "scrobbler-actions";
    anchor.appendChild(container);
  }
  return container;
}

function ensureBadge(container: HTMLElement): HTMLElement {
  let badge = container.querySelector(`[${BADGE_ATTR}]`) as HTMLElement | null;
  if (!badge) {
    badge = document.createElement("span");
    badge.setAttribute(BADGE_ATTR, "1");
    badge.className = "scrobbler-badge";
    container.appendChild(badge);
  }
  return badge;
}

function ensureAction(container: HTMLElement, attr: string, kind: string): HTMLElement {
  let button = container.querySelector(`[${attr}]`) as HTMLElement | null;
  if (!button) {
    button = document.createElement("span");
    button.setAttribute(attr, "1");
    button.className = "scrobbler-action";
    button.setAttribute("role", "button");
    button.setAttribute("tabindex", "0");
    button.dataset.kind = kind;
    container.appendChild(button);
  }
  return button;
}

function wireAction(button: HTMLElement, label: string, pressed: boolean | undefined, onActivate?: () => void): void {
  button.title = label;
  button.setAttribute("aria-label", label);
  if (pressed === undefined) button.removeAttribute("aria-pressed");
  else button.setAttribute("aria-pressed", pressed ? "true" : "false");
  button.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    onActivate?.();
  };
  button.onkeydown = (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    onActivate?.();
  };
}

function icon(path: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

function trashGlyph(): string {
  return icon('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/>');
}

function disableSyncGlyph(): string {
  return icon('<circle cx="12" cy="12" r="7"/><path d="M7 17 17 7"/>');
}

function enableSyncGlyph(): string {
  return icon('<path d="M20 6 9 17l-5-5"/>');
}
