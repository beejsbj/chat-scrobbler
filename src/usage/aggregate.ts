import type { UsageBucket, UsageIncrement } from "./types";

const NUMBER_KEYS = [
  "sessions",
  "messages",
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteTokens",
  "outputTokens",
  "reasoningTokens",
  "totalTokens",
] as const;

function keyOf(value: Pick<UsageBucket, "date" | "source" | "surface" | "device" | "project" | "model">): string {
  return [value.date, value.source, value.surface, value.device, value.project, value.model].join("\u001f");
}

export class UsageAccumulator {
  private readonly values = new Map<string, UsageBucket>();

  add(increment: UsageIncrement): void {
    const key = keyOf(increment);
    const existing = this.values.get(key) ?? {
      date: increment.date,
      source: increment.source,
      surface: increment.surface,
      device: increment.device,
      project: increment.project,
      model: increment.model,
      sessions: 0,
      messages: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    };
    for (const numberKey of NUMBER_KEYS) existing[numberKey] += increment[numberKey] ?? 0;
    this.values.set(key, existing);
  }

  list(): UsageBucket[] {
    return [...this.values.values()].sort((a, b) =>
      a.date.localeCompare(b.date)
      || a.source.localeCompare(b.source)
      || a.project.localeCompare(b.project)
      || a.model.localeCompare(b.model)
    );
  }
}

export function isoDay(value: unknown, fallback = "Unknown"): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value < 10_000_000_000 ? value * 1000 : value);
    return Number.isNaN(date.valueOf()) ? fallback : date.toISOString().slice(0, 10);
  }
  if (typeof value === "string" && value !== "") {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? fallback : date.toISOString().slice(0, 10);
  }
  return fallback;
}

export function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

