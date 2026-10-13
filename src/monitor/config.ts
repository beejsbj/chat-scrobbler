import type { Source } from "../schema/types";

export interface MonitorConfig {
  monitorStaleDays?: Partial<Record<Source, number | null>>;
  monitorCoverageThreshold?: number;
  monitorRecentHours?: number;
  monitorStatePath?: string | null;
}

export function monitorSettings(file: MonitorConfig = {}, env: Record<string, string | undefined> = {}) {
  const staleDays: Record<Source, number | null> = { chatgpt: 7, claude: 7, gemini: 7 };
  for (const source of Object.keys(staleDays) as Source[]) {
    const value = file.monitorStaleDays?.[source];
    if (value === null || validNumber(value, 0, Infinity)) staleDays[source] = value!;
    const override = env[`CHAT_SCROBBLER_MONITOR_STALE_DAYS_${source.toUpperCase()}`];
    if (override === "off") staleDays[source] = null;
    else if (override?.trim() && validNumber(Number(override), 0, Infinity)) staleDays[source] = Number(override);
  }
  const number = (value: unknown, fallback: number, min: number, max: number) => validNumber(value, min, max) ? value as number : fallback;
  return {
    monitorStaleDays: staleDays,
    monitorCoverageThreshold: number(env.CHAT_SCROBBLER_MONITOR_COVERAGE_THRESHOLD?.trim() ? Number(env.CHAT_SCROBBLER_MONITOR_COVERAGE_THRESHOLD) : file.monitorCoverageThreshold, 0.95, 0, 1),
    monitorRecentHours: number(env.CHAT_SCROBBLER_MONITOR_RECENT_HOURS?.trim() ? Number(env.CHAT_SCROBBLER_MONITOR_RECENT_HOURS) : file.monitorRecentHours, 48, Number.MIN_VALUE, Infinity),
    monitorStatePath: env.CHAT_SCROBBLER_MONITOR_STATE_PATH || (typeof file.monitorStatePath === "string" && file.monitorStatePath ? file.monitorStatePath : null),
  };
}

function validNumber(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}
