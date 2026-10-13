import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { startServe } from "../src/cli/commands";
import { openIndex, indexSession } from "../src/indexer/sqlite";
import { fixture } from "./support/embedding-fixture";

test("serve exposes its configured scheduler through deep health and stops it with ingest", async () => {
  const root=mkdtempSync(join(tmpdir(),"serve-backfill-"));
  const cfg={...DEFAULT_CONFIG,indexPath:join(root,"index.db"),canonicalDir:join(root,"canonical","sessions"),
    ingestPort:0,mcpHttpPort:0,ingestToken:"test",embeddingProvider:"hash" as const,embeddingBackfillBatchSize:1};
  const db=openIndex(cfg.indexPath);indexSession(db,fixture());db.close();
  const handles=await startServe(cfg);
  try {
    expect(handles.backfillScheduler).toBeTruthy();
    const deep=()=>fetch(`http://127.0.0.1:${handles.ingestServer.port}/health/deep`,{headers:{authorization:"Bearer test"}});
    expect(await (await deep()).json()).toMatchObject({backfill:{enabled:true,last_run:null,batch_size:1}});
    await handles.backfillScheduler!.runNow();
    expect(await (await deep()).json()).toMatchObject({backfill:{last_run:{outcome:"complete",report:{embedded:1}}}});
    expect((await fetch(`http://127.0.0.1:${handles.ingestServer.port}/status/report`)).status).toBe(404);
    handles.ingestServer.stop(true);
    await Bun.sleep(0);
    expect(handles.backfillScheduler!.status().state).toBe("stopped");
  } finally {await handles.backfillScheduler?.stop();handles.ingestServer.stop(true);handles.mcpServer.stop(true);rmSync(root,{recursive:true,force:true});}
});

test("serve CLI releases a live background lock and closes on SIGTERM and SIGINT", async () => {
  const {existsSync,writeFileSync}=await import("node:fs");
  const {backfillLockPath}=await import("../src/indexer/backfill-lock");
  for(const [signal,code] of [["SIGTERM",0],["SIGINT",130]] as const) {
    const root=mkdtempSync(join(tmpdir(),"serve-shutdown-"));
    let enter!:()=>void,release!:()=>void;
    const entered=new Promise<void>(resolve=>{enter=resolve;}),blocked=new Promise<void>(resolve=>{release=resolve;});
    const providerServer=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(){enter();await blocked;return new Response(JSON.stringify({embeddings:[[1,0]]}));}});
    const cfg={...DEFAULT_CONFIG,indexPath:join(root,"index.db"),canonicalDir:join(root,"canonical","sessions"),
      ingestPort:0,mcpHttpPort:0,embeddingProvider:"ollama",embeddingModel:"test",embeddingBackfillIntervalMs:20,
      ollamaBaseUrl:`http://127.0.0.1:${providerServer.port}`};
    const db=openIndex(cfg.indexPath);indexSession(db,fixture());db.close();
    const configPath=join(root,"config.json");writeFileSync(configPath,JSON.stringify(cfg));
    const child=Bun.spawn([process.execPath,join(import.meta.dir,"../src/cli/chat-scrobbler.ts"),"serve"],{
      env:{...process.env,CHAT_SCROBBLER_CONFIG:configPath,INDEX_PATH:cfg.indexPath,CANONICAL_DIR:cfg.canonicalDir,
        CHAT_SCROBBLER_EMBED_PROVIDER:"ollama",CHAT_SCROBBLER_EMBED_MODEL:"test",CHAT_SCROBBLER_OLLAMA_BASE_URL:cfg.ollamaBaseUrl,
        CHAT_SCROBBLER_EMBED_BACKFILL_ENABLED:"true",CHAT_SCROBBLER_EMBED_BACKFILL_INTERVAL_MS:"20",PORT:"0",MCP_HTTP_PORT:"0",BIND_HOST:"127.0.0.1"},stdout:"pipe",stderr:"pipe"});
    let watchdog:ReturnType<typeof setTimeout>|undefined;
    try {
      await Promise.race([entered,new Promise<never>((_,reject)=>{watchdog=setTimeout(()=>reject(new Error("provider not entered")),3000);})]);
      clearTimeout(watchdog);
      expect(existsSync(backfillLockPath(cfg.indexPath))).toBe(true);
      child.kill(signal);
      const exit=await Promise.race([child.exited,new Promise<never>((_,reject)=>{watchdog=setTimeout(()=>reject(new Error("shutdown did not abort provider")),3000);})]);
      expect(exit).toBe(code);
      expect(existsSync(backfillLockPath(cfg.indexPath))).toBe(false);
      expect(await new Response(child.stderr).text()).not.toContain("Error:");
    } finally {clearTimeout(watchdog);if(child.exitCode===null)child.kill("SIGKILL");await child.exited;release();providerServer.stop(true);rmSync(root,{recursive:true,force:true});}
  }
},10000);
