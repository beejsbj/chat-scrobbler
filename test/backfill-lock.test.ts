import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireBackfillLock, backfillLockPath } from "../src/indexer/backfill-lock";

test("backfill locks exclude same-process and separate-process writers for one index", async () => {
  const root = mkdtempSync(join(tmpdir(), "backfill-lock-"));
  const index = join(root, "index.db");
  try {
    const lock = acquireBackfillLock(index)!;
    expect(lock).toBeTruthy();
    expect(acquireBackfillLock(join(root, ".", "index.db"))).toBeNull();
    const child = Bun.spawn([process.execPath, "-e", `import {acquireBackfillLock} from ${JSON.stringify(join(import.meta.dir, "../src/indexer/backfill-lock.ts"))}; const l=acquireBackfillLock(${JSON.stringify(index)}); l?.release(); process.exit(l?1:0);`], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
    lock.release();
    const again = acquireBackfillLock(index)!;
    expect(again).toBeTruthy();
    again.release();
    expect(existsSync(backfillLockPath(index))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("dead PID lock recovers, live PID never expires, and release verifies ownership", async () => {
  const root = mkdtempSync(join(tmpdir(), "backfill-stale-"));
  const index = join(root, "index.db"), path = backfillLockPath(index);
  try {
    const initial=acquireBackfillLock(index)!;
    const namespace=JSON.parse(await Bun.file(join(path,readdirSync(path)[0])).text()).namespace;
    initial.release();
    mkdirSync(path);
    const dead = Bun.spawn([process.execPath, "-e", ""], {stdout:"ignore",stderr:"ignore"});
    await dead.exited;
    writeFileSync(join(path, `${dead.pid}-dead.json`), JSON.stringify({pid:dead.pid,token:"dead",namespace,started_at:"2000-01-01"}));
    const lock = acquireBackfillLock(index)!;
    expect(lock).toBeTruthy();
    lock.release();
    mkdirSync(path);
    writeFileSync(join(path, `${process.pid}-live.json`), JSON.stringify({pid:process.pid,token:"live",namespace,started_at:"2000-01-01"}));
    expect(acquireBackfillLock(index)).toBeNull();
    rmSync(path, {recursive:true});
    const owned = acquireBackfillLock(index)!;
    const file = readdirSync(path)[0];
    writeFileSync(join(path,file), JSON.stringify({pid:process.pid,token:"replacement"}));
    owned.release();
    expect(existsSync(join(path,file))).toBe(true);
  } finally { rmSync(root, {recursive:true,force:true}); }
});


test("foreign or missing PID namespaces fail closed even when their PID is dead locally", async () => {
  const root=mkdtempSync(join(tmpdir(),"backfill-namespace-")),index=join(root,"index.db");
  const path=backfillLockPath(index);
  const child=Bun.spawn([process.execPath,"-e",""],{stdout:"ignore",stderr:"ignore"});await child.exited;
  try {
    for(const namespace of [undefined,"pid:[foreign]"]) {
      mkdirSync(path);
      const file=join(path,`${child.pid}-foreign.json`);
      writeFileSync(file,JSON.stringify({pid:child.pid,token:"foreign",namespace}));
      expect(acquireBackfillLock(index)).toBeNull();expect(existsSync(file)).toBe(true);
      rmSync(path,{recursive:true});
    }
  } finally {rmSync(root,{recursive:true,force:true});}
});
