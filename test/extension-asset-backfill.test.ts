import { expect, test } from "bun:test";
import { backfillProviderAssets } from "../packages/extension/src/asset-backfill";
import type { AssetBackfillPage } from "../packages/shared/src";

test("backfill fetches canonical pointers at a bounded pace and commits only successes", async () => {
  const pauses: number[] = [];
  const committed: unknown[] = [];
  const provider: any = { source: "chatgpt", backfillAssets: async (_id: string, refs: any[], options: any) => {
    await options.beforeFetch();
    await options.beforeFetch();
    expect(refs.map(r => r.pointer)).toEqual(["sediment://available", "sediment://expired"]);
    return [{ pointer: refs[0].pointer, local_path: "assets/chatgpt/c/hash", sha256: "a".repeat(64) }];
  } };
  const page: AssetBackfillPage = { ok: true, sessions: [{ source_id: "c", references: [
    { pointer: "sediment://available", message_id: "m", filename: null, content_type: "image/png" },
    { pointer: "sediment://expired", message_id: "m", filename: null, content_type: "image/png" },
  ] }], next_after: "c" };
  const result = await backfillProviderAssets(provider, page, {
    uploadAsset: async () => { throw new Error("unused"); },
    commit: async value => { committed.push(value); },
    pause: async ms => { pauses.push(ms); },
  });
  expect(pauses).toEqual([1000, 1000]);
  expect(committed).toMatchObject([{ source: "chatgpt", source_id: "c", assets: [{ pointer: "sediment://available" }] }]);
  expect(result).toEqual({ sessions: 1, attempted: 2, captured: 1, unavailable: 1, next_after: "c" });
});
