import type { Database } from "bun:sqlite";
import { BACKFILL_MAX_BODY_BYTES, type AssetBackfillPage, type ProviderSource } from "../../shared/src";
import { ignoredAssetKeys, ignoreKey, reportedPointer } from "../../../src/monitor/asset-ignores";
import { BackfillError, commitBackfill, listBackfillPage, parseBackfillLimit } from "../../../src/core/asset-backfill";
import { BodyTooLargeError, readBoundedBody } from "./bounded-body";
import { SessionDeletedError, writeUnlessDeleted } from "../../../src/core/delete-session";
import { isSessionDeleted } from "../../../src/store/tombstones";

type Reply = (body: unknown, status?: number) => Response;

/** The owner stopped retries for ignored assets, so backfill does not offer them. Best effort: unreadable state offers everything. */
function withoutIgnoredAssets(page: AssetBackfillPage, source: ProviderSource, statePath?: string): AssetBackfillPage {
  if (!statePath) return page;
  let ignored: Set<string>;
  try { ignored = ignoredAssetKeys(statePath, source); } catch { return page; }
  if (!ignored.size) return page;
  const sessions = page.sessions.flatMap(session => {
    const references = session.references.filter(ref => !ignored.has(ignoreKey(session.source_id, ref.message_id, reportedPointer(ref.pointer))));
    return references.length ? [{ ...session, references }] : [];
  });
  return { ...page, sessions };
}

/** GET /assets/backfill and POST /assets/backfill; errors are categorical, never provider data. */
export async function handleAssetBackfill(
  req: Request,
  url: URL,
  ctx: { canonicalDir: string; rawDir: string; db: Database; readSource: (value: string | null) => ProviderSource; monitorStatePath?: string },
  reply: Reply,
): Promise<Response> {
  try {
    if (req.method === "GET") {
      const source = ctx.readSource(url.searchParams.get("source"));
      const limit = parseBackfillLimit(url.searchParams.get("limit"));
      return reply(withoutIgnoredAssets(listBackfillPage(ctx.canonicalDir, source, url.searchParams.get("after"), limit, ctx.rawDir), source, ctx.monitorStatePath));
    }
    let body: any;
    try { body = JSON.parse(new TextDecoder().decode(await readBoundedBody(req, BACKFILL_MAX_BODY_BYTES))); }
    catch (error) {
      if (error instanceof BodyTooLargeError) return reply({ ok: false, error: "request body too large" }, 413);
      throw new BackfillError(400, "body must be valid JSON");
    }
    if (!body || typeof body !== "object" || typeof body.source_id !== "string") throw new BackfillError(400, "body requires { source, source_id, assets[] }");
    const source = ctx.readSource(typeof body.source === "string" ? body.source : null);
    if (isSessionDeleted(ctx.canonicalDir, source, body.source_id)) throw new BackfillError(410, "session was deleted");
    const result = writeUnlessDeleted(ctx, ctx.db, source, body.source_id,
      () => commitBackfill({ canonicalDir: ctx.canonicalDir, rawDir: ctx.rawDir, db: ctx.db, source, sourceId: body.source_id, assets: body.assets }));
    return reply({ ok: true, ...result });
  } catch (error) {
    if (error instanceof SessionDeletedError) return reply({ ok: false, error: error.message }, 410);
    if (error instanceof BackfillError) return reply({ ok: false, error: error.message }, error.status);
    if (error instanceof Error && /^(source|source_id) is invalid$/.test(error.message)) return reply({ ok: false, error: error.message }, 400);
    console.error(JSON.stringify({ event: "asset_backfill_failed", reason: "unexpected_error" }));
    return reply({ ok: false, error: "asset_backfill_failed" }, 500);
  }
}
