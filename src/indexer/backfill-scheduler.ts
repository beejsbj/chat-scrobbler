import type { ChatHistoryConfig } from "../config";
import { openIndex, type EmbeddingProvider } from "./sqlite";
import { acquireBackfillLock, readBackfillLease, type BackfillLeaseStatus } from "./backfill-lock";
import { embedBackfill, type BackfillReport } from "./embed-backfill";

export interface BackfillSchedulerStatus {
  enabled: boolean;
  state: "disabled" | "scheduled" | "running" | "backoff" | "locked" | "stopped";
  running: boolean;
  interval_ms: number;
  batch_size: number;
  next_run_at: string | null;
  consecutive_failures: number;
  progress: BackfillReport | null;
  lease: BackfillLeaseStatus | null;
  lease_probe?: "unavailable";
  last_run: {
    started_at: string; finished_at: string;
    outcome: "complete" | "provider_unavailable" | "failed" | "locked" | "interrupted" | "lease_lost";
    report: BackfillReport | null;
    lease: BackfillLeaseStatus | null;
  } | null;
}
export interface BackfillScheduler {
  status(): BackfillSchedulerStatus;
  runNow(): Promise<BackfillReport | null>;
  stop(): Promise<void>;
}
interface SchedulerOptions {
  cfg: ChatHistoryConfig;
  provider: EmbeddingProvider | null;
  /** Across text and assets together; pages are at most 100 rows. */
  scanLimit?: number;
  yieldToQueries?: () => Promise<void>;
  now?: () => number;
  random?: () => number;
}

/** One serial batch per interval, starting after listeners and cache warmup.
 * Unfinished, underfilled sweeps continue after 1s; a full batch or full sweep
 * waits the configured interval. This keeps covered prefixes from hiding new work.
 * Database and provider work stay lazy. CLI and other servers share the SQLite heartbeat lease. */
export function startEmbeddingBackfillScheduler(opts: SchedulerOptions): BackfillScheduler {
  const {cfg,provider}=opts, now=opts.now ?? Date.now;
  const interval=cfg.embeddingBackfillIntervalMs, batch=cfg.embeddingBackfillBatchSize;
  const enabled=cfg.embeddingBackfillEnabled && provider !== null;
  const status: BackfillSchedulerStatus={enabled,state:enabled ? "scheduled" : "disabled",running:false,
    interval_ms:interval,batch_size:batch,next_run_at:null,consecutive_failures:0,progress:null,lease:null,last_run:null};
  let timer: ReturnType<typeof setTimeout> | undefined, active: Promise<BackfillReport|null> | undefined;
  let stopped=false, controller: AbortController | undefined, cursor=0, assetCursor="", delay=interval;
  const clear=()=> {clearTimeout(timer);timer=undefined;status.next_run_at=null;};
  const arm=()=> {
    if(stopped || !enabled) return;
    status.next_run_at=new Date(now()+delay).toISOString();
    timer=setTimeout(()=>{void runNow();},delay);
    timer.unref();
  };
  const backoff=()=> {
    status.consecutive_failures++;
    const cap=Math.max(interval,3_600_000);
    const base=Math.min(cap,interval*2**Math.min(10,status.consecutive_failures-1));
    delay=Math.min(cap,Math.round(base*(0.75+0.5*(opts.random ?? Math.random)())));
    status.state="backoff";
  };
  const run=async(): Promise<BackfillReport|null> => {
    const started_at=new Date(now()).toISOString();
    let report: BackfillReport|null=null, outcome: NonNullable<BackfillSchedulerStatus["last_run"]>["outcome"]="failed";
    let lock: ReturnType<typeof acquireBackfillLock> = null, db: ReturnType<typeof openIndex> | undefined;
    try {
      if(stopped) {outcome="interrupted";return null;}
      lock=acquireBackfillLock(cfg.indexPath);
      if(!lock) {
        outcome="locked";status.state="locked";status.lease=readBackfillLease(cfg.indexPath);
        // Retry live/recoverable leases promptly rather than waiting ten minutes.
        delay=Math.min(interval,15_000);return null;
      }
      status.lease=lock.status();
      controller=new AbortController();
      db=openIndex(cfg.indexPath);
      report=await embedBackfill(db,{provider:provider!,canonicalDir:cfg.canonicalDir,limit:batch,
        background:{cursor,assetCursor,scanLimit:opts.scanLimit ?? 1000},signal:AbortSignal.any([controller.signal,lock.signal]),
        assertLease:()=>lock!.assertOwned(db!),leaseStatus:()=>lock!.status(),
        yieldToQueries:opts.yieldToQueries,progress:report=>{status.progress=report;status.lease=report.lease ?? status.lease;}});
      // Failed items remain pending for the next sweep without pinning its cursor.
      cursor=report.scan?.exhausted ? 0 : report.scan?.cursor ?? cursor;
      assetCursor=report.scan?.exhausted ? "" : report.scan?.asset_cursor ?? assetCursor;
      if(report.failed) {outcome="provider_unavailable";backoff();}
      else {
        outcome="complete";status.state="scheduled";status.consecutive_failures=0;
        delay=report.scan && !report.scan.exhausted && report.attempted<batch ? Math.min(1000,interval) : interval;
      }
      return report;
    } catch {
      if(lock?.signal.aborted) {outcome="lease_lost";status.state="backoff";delay=Math.min(interval,15_000);}
      else if(controller?.signal.aborted) outcome="interrupted";
      else backoff(); // Public status contains reason codes, never provider/body errors.
      return null;
    } finally {
      controller=undefined;
      try {db?.close();} finally {
        try {lock?.release();} finally {
          if(lock) status.lease=lock.status();
          status.last_run={started_at,finished_at:new Date(now()).toISOString(),outcome,report,lease:status.lease};
        }
      }
    }
  };
  function runNow(): Promise<BackfillReport|null> {
    if(stopped || !enabled) return Promise.resolve(null);
    if(active) return active;
    clear();status.running=true;status.state="running";status.progress=null;
    active=Promise.resolve().then(run).catch(()=> {
      if(status.last_run) status.last_run.outcome="failed";
      backoff();return null;
    }).finally(()=> {
      active=undefined;status.running=false;
      if(stopped) status.state="stopped";
      else arm();
    });
    return active;
  }
  arm();
  return {
    status:()=> {
      const snapshot=structuredClone(status);
      // Inspect persisted leases even before the first scheduled run. Expired
      // owners must be visible in deep health during startup/recovery.
      try {
        const persisted=readBackfillLease(cfg.indexPath);
        if(persisted && snapshot.lease?.state!=="lost") snapshot.lease={...persisted,
          recovered:snapshot.lease?.recovered ?? false};
      } catch {snapshot.lease_probe="unavailable";}
      return snapshot;
    },runNow,
    async stop() {
      stopped=true;clear();controller?.abort(new Error("background backfill stopped"));
      await active;status.running=false;status.state="stopped";
    },
  };
}
