import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireBackfillLock, readBackfillLease } from "../src/indexer/backfill-lock";

function setup() {
  const root=mkdtempSync(join(tmpdir(),"backfill-lease-"));
  return {root,index:join(root,"index.db")};
}
const modulePath=join(import.meta.dir,"../src/indexer/backfill-lock.ts");

test("concurrent SQLite lease acquisitions admit exactly one process", async () => {
  const {root,index}=setup();
  try {
    // Initialize schema before racing independent connections.
    acquireBackfillLock(index)!.release();
    const children=Array.from({length:4},()=>Bun.spawn([process.execPath,"-e",`
      import {acquireBackfillLock} from ${JSON.stringify(modulePath)};
      const lease=acquireBackfillLock(${JSON.stringify(index)});
      console.log(lease ? 'held' : 'busy');
      if(lease) {await Bun.sleep(500);lease.release();}
    `],{stdout:"pipe",stderr:"pipe"}));
    const output=await Promise.all(children.map(async child=>{
      const text=await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);return text.trim();
    }));
    expect(output.filter(value=>value==="held")).toHaveLength(1);
    expect(readBackfillLease(index)).toBeNull();
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("expiry permits CAS takeover and an old holder cannot renew or release its replacement", () => {
  const {root,index}=setup();let clock=1000;
  const opts={now:()=>clock};
  const first=acquireBackfillLock(index,opts)!;
  let second: ReturnType<typeof acquireBackfillLock>=null;
  try {
    expect(first.status()).toMatchObject({state:"held",recovered:false,expires_at:61_000});
    expect(acquireBackfillLock(index,opts)).toBeNull();
    clock=61_000;
    expect(readBackfillLease(index,clock)).toMatchObject({state:"stale"});
    second=acquireBackfillLock(index,opts)!;
    expect(second.status()).toMatchObject({state:"held",recovered:true,recoveries:1,recovered_at:61_000});
    expect(first.renew()).toBe(false);
    expect(first.signal.aborted).toBe(true);
    expect(()=>first.assertOwned()).toThrow("backfill lease lost");
    first.release();
    expect(readBackfillLease(index,clock)).toMatchObject({state:"held",expires_at:121_000});
    second.assertOwned();
  } finally {first.release();second?.release();rmSync(root,{recursive:true,force:true});}
});

test("heartbeat extends a live holder beyond the original expiry without displacement", async () => {
  const {root,index}=setup();
  const lease=acquireBackfillLock(index,{leaseMs:180,heartbeatMs:30})!;
  try {
    const initial=lease.status().expires_at!;
    await Bun.sleep(240);
    expect(lease.status().expires_at!).toBeGreaterThan(initial);
    expect(acquireBackfillLock(index)).toBeNull();
    lease.assertOwned();
  } finally {lease.release();rmSync(root,{recursive:true,force:true});}
});

test("a process killed without release is recovered automatically after its heartbeat expires", async () => {
  const {root,index}=setup();
  const child=Bun.spawn([process.execPath,"-e",`
    import {acquireBackfillLock} from ${JSON.stringify(modulePath)};
    acquireBackfillLock(${JSON.stringify(index)},{leaseMs:250,heartbeatMs:40});
    console.log('ready');await Bun.sleep(10000);
  `],{stdout:"pipe",stderr:"pipe"});
  let replacement: ReturnType<typeof acquireBackfillLock>=null;
  try {
    const reader=child.stdout.getReader();await reader.read();reader.releaseLock();
    expect(acquireBackfillLock(index)).toBeNull();
    child.kill("SIGKILL");await child.exited;
    const expiry=readBackfillLease(index)!.expires_at!;
    await Bun.sleep(Math.max(0,expiry-Date.now())+30);
    replacement=acquireBackfillLock(index)!;
    expect(replacement.status()).toMatchObject({recovered:true,recoveries:1});
    replacement.assertOwned();
  } finally {child.kill();await child.exited;replacement?.release();rmSync(root,{recursive:true,force:true});}
});
