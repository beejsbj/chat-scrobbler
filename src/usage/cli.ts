import { parseArgs } from "node:util";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { collectLocalUsage, collectWebSnapshot, defaultSnapshotDir, mergeRecentSnapshot, writeSnapshot } from "./collect";
import type { UsageSnapshot } from "./types";
import { startUsageServer } from "./server";

export async function runUsageCommand(args: string[], write = (line: string) => process.stdout.write(line + "\n")): Promise<void> {
  const [action = "collect", ...rest] = args;
  const { values } = parseArgs({
    args: rest,
    options: {
      out: { type: "string" },
      device: { type: "string" },
      "snapshot-dir": { type: "string" },
      "canonical-dir": { type: "string" },
      "web-only": { type: "boolean", default: false },
      port: { type: "string" },
      host: { type: "string" },
      "incremental-days": { type: "string" },
    },
    strict: false,
  });
  const device = (values.device as string | undefined) ?? process.env.USAGE_DEVICE ?? hostname();
  const snapshotDir = (values["snapshot-dir"] as string | undefined) ?? process.env.USAGE_SNAPSHOT_DIR ?? defaultSnapshotDir();
  const canonicalDir = (values["canonical-dir"] as string | undefined) ?? process.env.CANONICAL_DIR;

  if (action === "collect") {
    const out = (values.out as string | undefined) ?? join(snapshotDir, `${device}.json`);
    const incrementalDays = Number(values["incremental-days"] ?? 0);
    const incremental = Number.isFinite(incrementalDays) && incrementalDays > 0 && existsSync(out);
    const cutoffMs = incremental ? Date.now() - incrementalDays * 86_400_000 : undefined;
    const cutoffDay = cutoffMs === undefined ? undefined : new Date(cutoffMs).toISOString().slice(0, 10);
    const collected = values["web-only"]
      ? await collectWebSnapshot(canonicalDir ?? join(homedir(), ".local", "share", "chat-scrobbler", "canonical", "sessions"), device, cutoffMs)
      : await collectLocalUsage({ device, canonicalDir, includeWeb: Boolean(canonicalDir), modifiedSinceMs: cutoffMs });
    let snapshot = collected;
    if (incremental && cutoffDay) {
      try {
        const existing = JSON.parse(readFileSync(out, "utf8")) as UsageSnapshot;
        if (existing.schemaVersion === 1) snapshot = mergeRecentSnapshot(existing, collected, cutoffDay);
      } catch { /* A damaged prior snapshot falls back to a fresh recent snapshot. */ }
    }
    writeSnapshot(out, snapshot);
    write(`Usage snapshot: ${out}`);
    write(`Buckets: ${snapshot.buckets.length}; coverage sources: ${snapshot.coverage.length}${incremental ? `; refreshed last ${incrementalDays} days` : ""}`);
    return;
  }

  if (action === "serve") {
    if (canonicalDir) {
      const web = await collectWebSnapshot(canonicalDir, device);
      writeSnapshot(join(snapshotDir, `${device}-web.json`), web);
      write(`Refreshed web archive snapshot (${web.buckets.length} buckets).`);
    }
    const port = Number((values.port as string | undefined) ?? process.env.USAGE_PORT ?? "4322");
    const bindHost = (values.host as string | undefined) ?? process.env.BIND_HOST ?? "127.0.0.1";
    const server = startUsageServer({ bindHost, port, snapshotDir });
    write(`Usage dashboard: http://${bindHost}:${server.port}`);
    await new Promise<void>(() => {});
    return;
  }

  throw new Error(`Unknown usage action "${action}". Use collect or serve.`);
}
