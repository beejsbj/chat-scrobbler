import { parseArgs } from "node:util";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { collectLocalUsage, collectWebSnapshot, defaultSnapshotDir, writeSnapshot } from "./collect";
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
    },
    strict: false,
  });
  const device = (values.device as string | undefined) ?? process.env.USAGE_DEVICE ?? hostname();
  const snapshotDir = (values["snapshot-dir"] as string | undefined) ?? process.env.USAGE_SNAPSHOT_DIR ?? defaultSnapshotDir();
  const canonicalDir = (values["canonical-dir"] as string | undefined) ?? process.env.CANONICAL_DIR;

  if (action === "collect") {
    const snapshot = values["web-only"]
      ? await collectWebSnapshot(canonicalDir ?? join(homedir(), ".local", "share", "chat-scrobbler", "canonical", "sessions"), device)
      : await collectLocalUsage({ device, canonicalDir, includeWeb: Boolean(canonicalDir) });
    const out = (values.out as string | undefined) ?? join(snapshotDir, `${device}.json`);
    writeSnapshot(out, snapshot);
    write(`Usage snapshot: ${out}`);
    write(`Buckets: ${snapshot.buckets.length}; coverage sources: ${snapshot.coverage.length}`);
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

