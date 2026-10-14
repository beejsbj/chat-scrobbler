import type { ChatHistoryConfig } from "../config";
import { openIndex, type EmbeddingProvider } from "./sqlite";
import { acquireBackfillLock, readBackfillLease, type BackfillLeaseStatus } from "./backfill-lock";
import { migrateVectorsInBackground, type VectorMigrationReport } from "./background-vector-migration";
import { initializePendingEmbeddings } from "./pending-embeddings";
import { deferWalCheckpoints } from "./background-wal-checkpoint";
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
  maintenance: {state:"idle"|"running"|"complete"|"failed";migration:VectorMigrationReport|null};
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
  startupMaintenance?: boolean;
}

/** One serial batch per interval, starting after listeners and cache warmup.
 * Due backlog continues after 1s; an empty queue waits the configured interval.
 * Pure startup maintenance has its own budget and yielding transactions.
 * Database and provider work stay lazy. CLI and other servers share the SQLite heartbeat lease. */
export function startEmbeddingBackfillScheduler(opts: SchedulerOptions): BackfillScheduler {
  const {cfg,provider}=opts, now=opts.now ?? Date.now;
  const interval=cfg.embeddingBackfillIntervalMs, batch=cfg.embeddingBackfillBatchSize;
  const enabled=cfg.embeddingBackfillEnabled && provider !== null;
  const status: BackfillSchedulerStatus={enabled,state:enabled ? "scheduled" : "disabled",running:false,
    interval_ms:interval,batch_size:batch,next_run_at:null,consecutive_failures:0,progress:null,lease:null,last_run:null,maintenance:{state:"idle",migration:null}};
  let timer: ReturnType<typeof setTimeout> | undefined, active: Promise<BackfillReport|null> | undefined;
  let stopped=false, controller: AbortController | undefined, delay=interval;
  const connectionSequence={count:0,lastItem:null as string|null},maintenanceController=new AbortController();
  const maintenance=opts.startupMaintenance ? Promise.resolve().then(async()=> {
    status.maintenance.state="running";
    try {
      status.maintenance.migration=await migrateVectorsInBackground(cfg.indexPath,{signal:maintenanceController.signal,
        progress:report=>{status.maintenance.migration=report;status.lease=report.lease ?? status.lease;}});
      status.lease=status.maintenance.migration.lease ?? status.lease;
      if(provider) {
        let lease:ReturnType<typeof acquireBackfillLock>=null;
        while(!(lease=acquireBackfillLock(cfg.indexPath))) {maintenanceController.signal.throwIfAborted();await Bun.sleep(50);}
        let db:ReturnType<typeof openIndex>|undefined,wal:ReturnType<typeof deferWalCheckpoints>|undefined;
        try {
          db=openIndex(cfg.indexPath);wal=deferWalCheckpoints(db);
          await initializePendingEmbeddings(db,provider,{signal:AbortSignal.any([maintenanceController.signal,lease.signal]),
            assertLease:()=>lease!.assertOwned(db!),yield:async()=>{await Bun.sleep(0);await wal!.checkpoint();}});
        } finally {try {wal?.restore();} finally {try{db?.close();}finally{lease.release();}}}
      }
      status.maintenance.state="complete";
    } catch {status.maintenance.state="failed";}
  }) : Promise.resolve();
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
      await maintenance;
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
        background:{cursor:0,scanLimit:opts.scanLimit ?? 1000},signal:AbortSignal.any([controller.signal,lock.signal]),
        assertLease:()=>lock!.assertOwned(db!),leaseStatus:()=>lock!.status(),connectionSequence,
        yieldToQueries:opts.yieldToQueries,progress:report=>{status.progress=report;status.lease=report.lease ?? status.lease;}});

      if(report.provider_outage) {outcome="provider_unavailable";backoff();}
      else {
        outcome="complete";status.state="scheduled";status.consecutive_failures=0;
        delay=report.scan && !report.scan.exhausted ? Math.min(1000,interval) : interval;
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
      stopped=true;clear();maintenanceController.abort(new Error("maintenance stopped"));controller?.abort(new Error("background backfill stopped"));
      await Promise.all([active,maintenance]);status.running=false;status.state="stopped";
    },
  };
}
