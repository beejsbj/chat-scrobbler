import { UsageAccumulator } from "./aggregate";
import type { CoverageItem, UsageSnapshot } from "./types";

export function mergeSnapshots(snapshots: UsageSnapshot[]): UsageSnapshot {
  const acc = new UsageAccumulator();
  const devices = new Set<string>();
  const coverage = new Map<string, CoverageItem>();
  let generatedAt = new Date(0).toISOString();
  for (const snapshot of snapshots) {
    if (snapshot.schemaVersion !== 1) continue;
    if (snapshot.generatedAt > generatedAt) generatedAt = snapshot.generatedAt;
    for (const device of snapshot.devices) devices.add(device);
    for (const bucket of snapshot.buckets) acc.add(bucket);
    for (const item of snapshot.coverage) {
      const key = [item.source, item.status, item.detail].join("\u001f");
      const prior = coverage.get(key);
      coverage.set(key, { ...item, records: (prior?.records ?? 0) + item.records });
    }
  }
  return {
    schemaVersion: 1,
    generatedAt,
    devices: [...devices].sort(),
    buckets: acc.list(),
    coverage: [...coverage.values()].sort((a, b) => a.source.localeCompare(b.source)),
  };
}

