import { parseArgs } from "node:util";
import type { ChatHistoryConfig } from "../config";
import { openIndex } from "../indexer/sqlite";
import { embeddingProviderFromConfig } from "../indexer/embedding-providers";
import { embedBackfill } from "../indexer/embed-backfill";
import { migrateLegacyVectors } from "../indexer/vector-store";
import { acquireBackfillLock, readBackfillLease } from "../indexer/backfill-lock";

export async function runEmbedBackfill(args: string[], cfg: ChatHistoryConfig, write: (text:string)=>void): Promise<void> {
  const {values}=parseArgs({args,options:{help:{type:"boolean",short:"h"},model:{type:"string"},provider:{type:"string"},limit:{type:"string"},rate:{type:"string"},"load-threshold":{type:"string"},"migrate-only":{type:"boolean"}}});
  if(values.help) {
    write(`Usage: chat-scrobbler embed-backfill --model <id> [options]
  --provider <kind>       Configured provider override
  --limit <n>             Maximum attempted items
  --rate <requests/s>     Serial request pacing (default 10)
  --load-threshold <n>    Optional host load brake
  --migrate-only         Convert legacy vectors without inference or --model
  --help, -h             Show this help

Shares a SQLite heartbeat lease with serve background backfill and migration.
Heartbeats renew every 15 seconds; a crashed holder expires after 60 seconds.
Container-shared indexes also support manual runs via docker exec.
Serve defaults: 25 attempts every 10 minutes when a provider is configured.
CHAT_SCROBBLER_EMBED_BACKFILL_ENABLED=false disables the background scheduler.
CHAT_SCROBBLER_EMBED_BACKFILL_INTERVAL_MS and CHAT_SCROBBLER_EMBED_BACKFILL_BATCH_SIZE override its controls.`);
    return;
  }
  const number=(key:"limit"|"rate"|"load-threshold", fallback:number)=>values[key] === undefined ? fallback : Number(values[key]);
  const limit=number("limit",Infinity), rate=number("rate",10), loadThreshold=values["load-threshold"] === undefined ? undefined : number("load-threshold",0);
  if ((values.limit!==undefined && (!Number.isInteger(limit)||limit<1)) || !Number.isFinite(rate)||rate<=0 || loadThreshold !== undefined && (!Number.isFinite(loadThreshold)||loadThreshold<=0)) throw new Error("invalid backfill controls");
  const providerKind=values.provider ?? cfg.embeddingProvider;
  if (!["none","hash","gemini","ollama","embeddinggemma"].includes(providerKind)) throw new Error("unsupported embedding provider");
  if (!values["migrate-only"] && !values.model?.trim()) throw new Error("embed-backfill requires --model");
  const provider=values["migrate-only"] ? null : embeddingProviderFromConfig({...cfg,embeddingProvider:providerKind as ChatHistoryConfig["embeddingProvider"],embeddingModel:values.model ?? null});
  if (!values["migrate-only"] && !provider) throw new Error("embed-backfill requires an enabled provider (or --provider)");
  const lock=acquireBackfillLock(cfg.indexPath);
  if (!lock) {
    write(JSON.stringify({event:"lease_busy",lease:readBackfillLease(cfg.indexPath)}));
    throw new Error("backfill already running for this index");
  }
  const abort=new AbortController();
  const stop=()=>abort.abort(new Error("backfill interrupted; completed vectors retained"));
  process.once("SIGINT",stop); process.once("SIGTERM",stop);
  let db: ReturnType<typeof openIndex> | undefined;
  try {
    write(JSON.stringify({event:"lease_acquired",lease:lock.status()}));
    db=openIndex(cfg.indexPath);
    if (values["migrate-only"]) {
      let scanned=0,converted=0,invalid=0;
      while (scanned<limit) {
        AbortSignal.any([abort.signal,lock.signal]).throwIfAborted();
        const result=migrateLegacyVectors(db,{limit:Math.min(100,limit-scanned),assertLease:()=>lock.assertOwned(db!)});
        scanned+=result.scanned; converted+=result.converted; invalid+=result.invalid;
        if(result.scanned<Math.min(100,limit-(scanned-result.scanned))) break;
        await Bun.sleep(50);
      }
      write(JSON.stringify({event:"migration_complete",scanned,converted,invalid,lease:lock.status()})); return;
    }
    const result=await embedBackfill(db,{provider:provider!,canonicalDir:cfg.canonicalDir,limit:values.limit===undefined ? undefined : limit,rate,loadThreshold,signal:AbortSignal.any([abort.signal,lock.signal]),assertLease:()=>lock.assertOwned(db!),leaseStatus:()=>lock.status(),progress:report=>write(JSON.stringify(report))});
    if(result.failed) throw new Error(`${result.failed} embeddings failed; resume to retry`);
  } catch(error) {
    if(lock.signal.aborted) write(JSON.stringify({event:"lease_lost",lease:lock.status()}));
    throw error;
  } finally {
    try { db?.close(); } finally {
      try {lock.release();} finally {process.removeListener("SIGINT",stop); process.removeListener("SIGTERM",stop);}
    }
  }
}
