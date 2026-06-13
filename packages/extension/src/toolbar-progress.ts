export interface ToolbarProgressInput {
  remaining: number;
  total: number;
}

export interface ToolbarProgressView {
  badgeText: string;
  badgeColor: string | null;
  spinning: boolean;
}

const ACTIVE_BADGE_COLOR = "#0969da";

export function toolbarProgressView(progress: ToolbarProgressInput): ToolbarProgressView {
  const remaining = Math.max(0, Math.floor(progress.remaining));
  if (remaining === 0) {
    return { badgeText: "", badgeColor: null, spinning: false };
  }
  return { badgeText: String(remaining), badgeColor: ACTIVE_BADGE_COLOR, spinning: true };
}

/**
 * Aggregate progress across all open provider tabs.
 * Pure function: takes the current per-tab Map and returns the summed totals.
 * Tabs with remaining=0 contribute 0 to the remaining sum (caller should remove
 * them from the map, but this function is safe even if they are present).
 */
export function aggregateTabProgress(
  tabs: Map<number, ToolbarProgressInput>,
): ToolbarProgressInput {
  let remaining = 0;
  let total = 0;
  for (const entry of tabs.values()) {
    remaining += Math.max(0, entry.remaining);
    total += Math.max(0, entry.total);
  }
  return { remaining, total };
}
