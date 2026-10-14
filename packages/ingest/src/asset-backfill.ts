import type { Database } from "bun:sqlite";
import type { ProviderSource } from "../../shared/src";
import { BACKFILL_MAX_BODY_BYTES, BackfillError, commitBackfill, listBackfillPage, parseBackfillLimit } from "../../../src/core/asset-backfill";
import { BodyTooLargeError, readBoundedBody } from "./bounded-body";

type Reply = (body: unknown, status?: number) => Response;

/** GET /assets/backfill and POST /assets/backfill; errors are categorical, never provider data. */
export async function handleAssetBackfill(
  req: Request,
  url: URL,
  ctx: { canonicalDir: string; rawDir: string; db: Database; readSource: (value: string | null) => ProviderSource },
  reply: Reply,
): Promise<Response> {
  try {
    if (req.method === "GET") {
      const source = ctx.readSource(url.searchParams.get("source"));
      const limit = parseBackfillLimit(url.searchParams.get("limit"));
      return reply(listBackfillPage(ctx.canonicalDir, source, url.searchParams.get("after"), limit));
    }
    let body: any;
    try { body = JSON.parse(new TextDecoder().decode(await readBoundedBody(req, BACKFILL_MAX_BODY_BYTES))); }
    catch (error) {
      if (error instanceof BodyTooLargeError) return reply({ ok: false, error: "request body too large" }, 413);
      throw new BackfillError(400, "body must be valid JSON");
    }
    if (!body || typeof body !== "object" || typeof body.source_id !== "string") throw new BackfillError(400, "body requires { source, source_id, assets[] }");
    const source = ctx.readSource(typeof body.source === "string" ? body.source : null);
    const result = commitBackfill({ canonicalDir: ctx.canonicalDir, rawDir: ctx.rawDir, db: ctx.db, source, sourceId: body.source_id, assets: body.assets });
    return reply({ ok: true, ...result });
  } catch (error) {
    if (error instanceof BackfillError) return reply({ ok: false, error: error.message }, error.status);
    if (error instanceof Error && /^(source|source_id) is invalid$/.test(error.message)) return reply({ ok: false, error: error.message }, 400);
    console.error(JSON.stringify({ event: "asset_backfill_failed", reason: "unexpected_error" }));
    return reply({ ok: false, error: "asset_backfill_failed" }, 500);
  }
}
