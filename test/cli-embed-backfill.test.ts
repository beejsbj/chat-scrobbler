import { test, expect, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as os from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { openIndex, indexSession } from "../src/indexer/sqlite";
import { runEmbedBackfill } from "../src/cli/embed-backfill";
import { fixture } from "./support/embedding-fixture";

test("CLI validates model/provider/controls before creating a database", async () => {
  for (const args of [[], ["--model","m","--provider","none"], ["--model","m","--rate","bad"], ["--model","m","--limit","0"], ["--provider","oops","--model","m"]]) {
    await expect(runEmbedBackfill(args,{...DEFAULT_CONFIG,indexPath:"/nonexistent-parent/no-write.db"},()=>{})).rejects.toThrow();
  }
});
test("CLI fills isolated hash fixtures and reports coverage without changing config", async () => {
  const root=mkdtempSync(join(tmpdir(),"embed-cli-"));
  try {
    const cfg={...DEFAULT_CONFIG,indexPath:join(root,"index.db")}; const db=openIndex(cfg.indexPath); indexSession(db,fixture()); db.close();
    const out:string[]=[];
    await runEmbedBackfill(["--model","hash-v1","--provider","hash","--limit","1","--rate","1000","--load-threshold","1000"],cfg,text=>out.push(text));
    expect(JSON.parse(out.at(-1)!)).toMatchObject({event:"complete",embedded:1,text:{total:1,embedded:1}});
    expect(cfg.embeddingProvider).toBe("none");
    const inspect=openIndex(cfg.indexPath); expect(inspect.query("SELECT * FROM message_vectors").all()).toHaveLength(1); inspect.close();
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("CLI migration ignores even an explicitly configured emergency host load brake", async () => {
  const root = mkdtempSync(join(tmpdir(), "embed-migrate-"));
  const load = spyOn(os, "loadavg").mockReturnValue([32, 32, 32]);
  const sleep = spyOn(Bun, "sleep").mockImplementation(async () => { throw new Error("unexpected load pause"); });
  try {
    const cfg = { ...DEFAULT_CONFIG, indexPath: join(root, "index.db") };
    const db = openIndex(cfg.indexPath);
    indexSession(db, fixture());
    db.run(`INSERT INTO message_embeddings(session_id,message_id,embedding,text,title,provider_kind,provider_model,dimension)
      VALUES ('chatgpt:test','m','[1,0]','archived words','T','test','m',2)`);
    db.close();
    const out: string[] = [];
    await runEmbedBackfill(["--migrate-only", "--load-threshold", "1"], cfg, text => out.push(text));
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ event: "migration_complete", scanned: 1, converted: 1, invalid: 0 });
    expect(load).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  } finally { load.mockRestore(); sleep.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

test("CLI defaults to serial inference without checking aggregate host load", async () => {
  const root = mkdtempSync(join(tmpdir(), "embed-load-"));
  const load = spyOn(os, "loadavg").mockReturnValue([32, 32, 32]);
  try {
    const cfg = { ...DEFAULT_CONFIG, indexPath: join(root, "index.db") };
    const db = openIndex(cfg.indexPath);
    indexSession(db, fixture());
    db.close();
    const out: string[] = [];
    await runEmbedBackfill(["--model", "hash-v1", "--provider", "hash"], cfg, text => out.push(text));
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ event: "complete", embedded: 1 });
    expect(load).not.toHaveBeenCalled();
  } finally { load.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

test("manual backfill and migrate-only use the same index lock and release it after errors", async () => {
  const { acquireBackfillLock } = await import("../src/indexer/backfill-lock");
  const root = mkdtempSync(join(tmpdir(), "embed-cli-lock-"));
  try {
    const cfg = {...DEFAULT_CONFIG,indexPath:join(root,"index.db")};
    const lock=acquireBackfillLock(cfg.indexPath)!;
    for (const args of [["--migrate-only"],["--model","hash-v1","--provider","hash"]])
      await expect(runEmbedBackfill(args,cfg,()=>{})).rejects.toThrow("backfill already running");
    lock.release();
    const db=openIndex(cfg.indexPath); indexSession(db,fixture()); db.close();
    await expect(runEmbedBackfill(["--provider","hash","--model","hash-v1"],cfg,()=>{throw new Error("writer failed");})).rejects.toThrow("writer failed");
    const again=acquireBackfillLock(cfg.indexPath)!;
    expect(again).toBeTruthy(); again.release();
  } finally {rmSync(root,{recursive:true,force:true});}
});
