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
    commit: async value => { committed.push(value); return { ok: true, linked: value.assets.length, raw_ref: null }; },
    pause: async ms => { pauses.push(ms); },
  });
  expect(pauses).toEqual([1000, 1000]);
  expect(committed).toMatchObject([{ source: "chatgpt", source_id: "c", assets: [{ pointer: "sediment://available" }] }]);
  expect(result).toEqual({ sessions: 1, attempted: 2, captured: 1, unavailable: 1, next_after: "c" });
});

const ackProvider = (count: number): any => ({ source: "chatgpt", backfillAssets: async (_id: string, refs: any[]) =>
  refs.slice(0, count).map(ref => ({ pointer: ref.pointer, local_path: "assets/chatgpt/c/hash", sha256: "a".repeat(64) })) });
const ackPage = (): AssetBackfillPage => ({ ok: true, next_after: "c", sessions: [{ source_id: "c", references: [
  { pointer: "p1", message_id: "m", filename: null, content_type: null },
  { pointer: "p2", message_id: "m", filename: null, content_type: null },
] }] });
const runWithReceipt = (receipt: unknown) => backfillProviderAssets(ackProvider(2), ackPage(), {
  uploadAsset: async () => { throw new Error("unused"); }, commit: async () => receipt, pause: async () => {},
});

test("backfill accepts a receipt whose linked count matches the commit, with or without a raw_ref", async () => {
  expect(await runWithReceipt({ ok: true, linked: 2, raw_ref: "raw/ref" })).toMatchObject({ captured: 2, next_after: "c" });
  expect(await runWithReceipt({ ok: true, linked: 2, raw_ref: null })).toMatchObject({ captured: 2 });
});

test("backfill fails the page when the commit acknowledgement does not match", async () => {
  for (const receipt of [undefined, null, "ok", { ok: true }, { ok: true, linked: 2 }, { ok: true, linked: 0, raw_ref: null },
    { ok: true, linked: 1, raw_ref: null }, { ok: true, linked: 3, raw_ref: null }, { ok: true, linked: "2", raw_ref: null },
    { ok: true, linked: 2, raw_ref: 7 }, { ok: false, linked: 2, raw_ref: null }]) {
    await expect(runWithReceipt(receipt)).rejects.toThrow(/acknowledgement/);
  }
});
