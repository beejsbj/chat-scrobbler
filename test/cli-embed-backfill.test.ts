import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
