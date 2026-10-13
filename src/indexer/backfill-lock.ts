import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const held = new Set<string>();
interface Owner { pid: number; token: string; namespace: string; }
export interface BackfillLock { release(): void; }
function namespaceFingerprint(): string {
  try {return `${readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim()}:${readlinkSync("/proc/self/ns/pid")}`;}
  catch {return `host:${hostname()}`;}
}

export function backfillLockPath(indexPath: string): string {
  const index = resolve(indexPath);
  const canonical = existsSync(index) ? realpathSync(index)
    : join(existsSync(dirname(index)) ? realpathSync(dirname(index)) : dirname(index), basename(index));
  return `${canonical}.embed-backfill.lock`;
}

function ownerAt(file: string): Owner | null {
  try {
    const owner = JSON.parse(readFileSync(file, "utf8"));
    return Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.token === "string" && typeof owner.namespace === "string" ? owner : null;
  } catch { return null; }
}
function live(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** A nonempty directory is the lockfile. Rename publishes PID and nonce atomically.
 * Recovery removes only the dead owner's unique filename, then rmdir checks that
 * no replacement owner is present. There is no TTL that can expire a live job.
 * Foreign/unknown PID namespaces fail closed: against a container-shared index,
 * run manual CLI through docker exec in the server's PID namespace. */
export function acquireBackfillLock(indexPath: string): BackfillLock | null {
  mkdirSync(dirname(resolve(indexPath)), {recursive:true});
  const path = backfillLockPath(indexPath);
  if (held.has(path)) return null;
  const owner: Owner = {pid:process.pid,token:randomUUID(),namespace:namespaceFingerprint()};
  const filename = `${owner.pid}-${owner.token}.json`, candidate = `${path}.${filename}`;
  mkdirSync(candidate);
  writeFileSync(join(candidate,filename),JSON.stringify(owner), {flag:"wx"});
  try {
    for (let attempt=0; attempt<3; attempt++) {
      try { renameSync(candidate,path); held.add(path); break; }
      catch (error) {
        if (!["EEXIST","ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        let files: string[];
        try {files=readdirSync(path);} catch(error) {
          if((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        if (files.length !== 1) return null; // Unknown/corrupt locks fail closed.
        const oldFile=join(path,files[0]), old=ownerAt(oldFile);
        if (!old || old.namespace!==owner.namespace || files[0] !== `${old.pid}-${old.token}.json` || live(old.pid)) return null;
        // Unique names keep competing recoverers from removing a new owner's file.
        try { unlinkSync(oldFile); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        try { rmdirSync(path); } catch (error) {
          if (!["ENOENT","ENOTEMPTY","EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        }
      }
    }
    if (!held.has(path)) return null;
    let released=false;
    return { release() {
      if (released) return;
      released=true;
      const file=join(path,filename), current=ownerAt(file);
      try {
        if (current?.pid===owner.pid && current.token===owner.token && current.namespace===owner.namespace) {
          unlinkSync(file);
          try { rmdirSync(path); } catch (error) {
            if (!["ENOENT","ENOTEMPTY","EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          }
        }
      } finally { held.delete(path); }
    } };
  } finally {
    if (existsSync(candidate)) { unlinkSync(join(candidate,filename)); rmdirSync(candidate); }
  }
}
