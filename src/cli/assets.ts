import type { ChatHistoryConfig } from "../config";
import { ignoreAsset, listFailingAssets, listIgnoredAssets, unignoreAsset, type AssetKey } from "../monitor/asset-ignores";
import { monitorStatePath } from "../monitor/state";

const USAGE = "usage: chat-scrobbler assets failing [--json] | ignored [--json] | ignore <id> | unignore <id>";
const MAX_POINTER_CHARS = 100;

function describe(asset: AssetKey & { id: string; reason: string }, when: string, extra = ""): string {
  const pointer = asset.pointer.length > MAX_POINTER_CHARS ? `${asset.pointer.slice(0, MAX_POINTER_CHARS)}...` : asset.pointer || "(none)";
  return `${asset.id} ${asset.source} ${asset.reason} ${extra}${when} session=${asset.source_id} message=${asset.message_id ?? "(none)"} pointer=${pointer}`;
}

/**
 * Manual ignore for failed assets. Extensions retry a failed asset with backoff until it is
 * ignored here; `failing` shows what is retrying, `ignore <id>` stops it, `unignore <id>` undoes that.
 * Returns the process exit code.
 */
export async function runAssetsCmd(cfg: Pick<ChatHistoryConfig, "indexPath" | "monitorStatePath">, args: string[], write: (line: string) => void): Promise<number> {
  const [sub, ...rest] = args;
  const path = monitorStatePath(cfg.indexPath, cfg.monitorStatePath);
  const json = rest.includes("--json");
  const ids = rest.filter(arg => !arg.startsWith("--"));
  try {
    if (sub === "failing" || sub === "ignored") {
      if (ids.length || rest.some(arg => arg.startsWith("--") && arg !== "--json")) { write(USAGE); return 1; }
      const assets = sub === "failing" ? listFailingAssets(path) : listIgnoredAssets(path);
      if (json) { write(JSON.stringify(assets, null, 2)); return 0; }
      if (!assets.length) { write(`no ${sub} assets`); return 0; }
      for (const asset of assets) {
        write(sub === "failing"
          ? describe(asset, `last_seen=${new Date((asset as any).last_seen).toISOString()}`, `attempts=${(asset as any).attempts} `)
          : describe(asset, `ignored_at=${new Date((asset as any).ignored_at).toISOString()}`));
      }
      return 0;
    }
    if ((sub === "ignore" || sub === "unignore") && ids.length === 1 && /^[a-f0-9]{12}$/.test(ids[0]) && rest.length === 1) {
      const result = sub === "ignore" ? ignoreAsset(path, ids[0]) : unignoreAsset(path, ids[0]);
      if (result.status === "not_found") { write(sub === "ignore" ? `no failing asset with id ${ids[0]} (see: chat-scrobbler assets failing)` : `no ignored asset with id ${ids[0]} (see: chat-scrobbler assets ignored)`); return 1; }
      if (result.status === "no_pointer") { write(`asset ${ids[0]} was reported with no pointer, so it cannot be ignored precisely; update the extension and wait for its next report`); return 1; }
      const asset = result.asset!;
      const detail = `${asset.source} session=${asset.source_id} message=${asset.message_id ?? "(none)"}`;
      write(result.status === "ignored" ? `ignored ${ids[0]} (${detail}); extensions stop retrying it after their next failure report`
        : result.status === "already_ignored" ? `${ids[0]} was already ignored (${detail})`
        : `unignored ${ids[0]} (${detail}); run an asset backfill in the extension to retry it now`);
      return 0;
    }
  } catch { write("FAILED assets state_unavailable (the receiver may be writing; try again)"); return 1; }
  write(USAGE);
  return 1;
}
