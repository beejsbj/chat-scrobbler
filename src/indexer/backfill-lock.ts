import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const name="embedding-backfill";
export interface BackfillLeaseStatus {
  state: "held" | "stale" | "lost" | "released";
  expires_at: number;
  heartbeat_at: number;
  recovered: boolean;
  recovered_at: number | null;
  recoveries: number;
}
interface LeaseRow { owner_token:string; expires_at:number; heartbeat_at:number; recovered_at:number|null; recoveries:number; }
export class BackfillLeaseLost extends Error {
  constructor() {super("backfill lease lost; pending vectors retained");}
}
export interface BackfillLock {
  signal: AbortSignal;
  /** Call inside the writer's IMMEDIATE transaction, before committing. */
  assertOwned(writer?: Database): void;
  renew(): boolean;
  status(): BackfillLeaseStatus;
  release(): void;
}
export function createBackfillLockTable(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS locks(name TEXT PRIMARY KEY,owner_token TEXT NOT NULL,
    expires_at INTEGER NOT NULL,heartbeat_at INTEGER NOT NULL,recovered_at INTEGER,recoveries INTEGER NOT NULL DEFAULT 0)`);
  // A coordination-only connection can precede openIndex. If search is already
  // initialized, track heartbeats without dirtying any text/model cache.
  if(db.query("SELECT 1 FROM sqlite_master WHERE name='search_revision'").get())
    for(const event of ["INSERT","UPDATE","DELETE"])
      db.run(`CREATE TRIGGER IF NOT EXISTS search_locks_${event.toLowerCase()} AFTER ${event} ON locks BEGIN
        UPDATE search_revision SET revision=revision+1 WHERE id=1; END`);
}
function describe(row: LeaseRow,now:number,recovered=false): BackfillLeaseStatus {
  return {state:row.expires_at>now ? "held" : "stale",expires_at:row.expires_at,heartbeat_at:row.heartbeat_at,
    recovered,recovered_at:row.recovered_at,recoveries:row.recoveries};
}
export function readBackfillLease(indexPath:string,now=Date.now()): BackfillLeaseStatus|null {
  if(!existsSync(indexPath)) return null;
  const db=new Database(indexPath,{readonly:true});
  try {
    if(!db.query("SELECT 1 FROM sqlite_master WHERE name='locks'").get()) return null;
    const row=db.query("SELECT * FROM locks WHERE name=?").get(name) as LeaseRow|null;
    return row ? describe(row,now) : null;
  } finally {db.close();}
}

/** SQLite serializes acquisition and CAS takeover across PID namespaces. Only a
 * heartbeat can extend ownership; expired holders must acquire a new token. */
export function acquireBackfillLock(indexPath:string,opts:{now?:()=>number;leaseMs?:number;heartbeatMs?:number}={}): BackfillLock|null {
  const now=opts.now ?? Date.now,ttl=opts.leaseMs ?? 60_000,heartbeat=opts.heartbeatMs ?? 15_000;
  if(!Number.isFinite(ttl)||!Number.isFinite(heartbeat)||heartbeat<=0||ttl<=heartbeat) throw new Error("invalid backfill lease timing");
  mkdirSync(dirname(indexPath),{recursive:true});
  const db=new Database(indexPath,{create:true});
  let transferred=false;
  try {
    db.run("PRAGMA busy_timeout=5000");
    // Coordination must not checkpoint unrelated bulk warmup/migration writes.
    // Archive writers retain checkpoint policy; bulk jobs use a worker.
    db.run("PRAGMA wal_autocheckpoint=0");
    createBackfillLockTable(db);
    const token=randomUUID();
    const acquired=db.transaction(()=> {
      const at=now(),old=db.query("SELECT * FROM locks WHERE name=?").get(name) as LeaseRow|null;
      if(old && old.expires_at>at) return null;
      const row: LeaseRow={owner_token:token,expires_at:at+ttl,heartbeat_at:at,
        recovered_at:old ? at : null,recoveries:(old?.recoveries ?? 0)+(old ? 1 : 0)};
      if(old) {
        const result=db.query(`UPDATE locks SET owner_token=?,expires_at=?,heartbeat_at=?,recovered_at=?,recoveries=?
          WHERE name=? AND owner_token=? AND expires_at=? RETURNING owner_token`).get(token,row.expires_at,at,at,row.recoveries,name,old.owner_token,old.expires_at);
        if(!result) return null;
      } else db.run("INSERT INTO locks VALUES (?,?,?,?,?,?)",[name,token,row.expires_at,at,null,0]);
      return {row,recovered:old!==null};
    }).immediate();
    if(!acquired) return null;
    const abort=new AbortController();let released=false;
    let snapshot=describe(acquired.row,now(),acquired.recovered);
    const lost=()=> {snapshot.state="lost";if(!abort.signal.aborted)abort.abort(new BackfillLeaseLost());};
    const assertOwned=(writer=db)=> {
      if(released || abort.signal.aborted) throw new BackfillLeaseLost();
      const row=writer.query("SELECT * FROM locks WHERE name=? AND owner_token=?").get(name,token) as LeaseRow|null;
      if(!row || row.expires_at<=now()) {lost();throw new BackfillLeaseLost();}
      snapshot=describe(row,now(),acquired.recovered);
    };
    const renew=()=> {
      if(released || abort.signal.aborted) return false;
      try {
        // Compute time only after obtaining the writer reservation. A busy wait
        // must not use an earlier timestamp to revive an already-expired token.
        const renewed=db.transaction(()=> {
          const at=now();
          const result=db.query(`UPDATE locks SET expires_at=?,heartbeat_at=? WHERE name=? AND owner_token=? AND expires_at>? RETURNING owner_token`).get(at+ttl,at,name,token,at);
          return result ? at : null;
        }).immediate();
        if(renewed===null) {lost();return false;}
        snapshot={...snapshot,state:"held",expires_at:renewed+ttl,heartbeat_at:renewed};return true;
      } catch {lost();return false;}
    };
    const timer=setInterval(renew,heartbeat);timer.unref();
    transferred=true;
    return {signal:abort.signal,assertOwned,renew,
      status:()=>({...snapshot,state:snapshot.state==="held" && snapshot.expires_at<=now() ? "stale" : snapshot.state}),
      release() {
        if(released) return;
        released=true;clearInterval(timer);
        try {db.run("DELETE FROM locks WHERE name=? AND owner_token=?",[name,token]);snapshot.state=snapshot.state==="lost" ? "lost" : "released";}
        finally {db.close();}
      },
    };
  } finally {if(!transferred)db.close();}
}
