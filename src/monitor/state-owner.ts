import { accessSync, constants, existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { rawDirForCanonicalDir } from "../store/raw";

export class MonitorStateError extends Error {
  constructor(readonly reason: "owner_mismatch" | "unwritable") { super(reason); }
}

export function monitorDataDir(canonicalDir: string): string {
  return dirname(rawDirForCanonicalDir(canonicalDir));
}

/** Check before mkdir/open: an elevated exec must not leave foreign-owned SQLite sidecars. */
export function assertStateOwner(path: string, dataDir = dirname(path)): void {
  let dir = resolve(dataDir);
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  const uid = statSync(dir).uid;
  if (process.getuid && process.getuid() !== uid) throw new MonitorStateError("owner_mismatch");
  let parent = resolve(dirname(path));
  while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent);
  try {
    const mode = statSync(parent).mode;
    if (!(mode & 0o222) || !(mode & 0o111)) throw new Error("directory permissions");
    accessSync(parent, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch { throw new MonitorStateError("unwritable"); }
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    if (!existsSync(file)) continue;
    if (statSync(file).uid !== uid) throw new MonitorStateError("owner_mismatch");
    if (!(statSync(file).mode & 0o222)) throw new MonitorStateError("unwritable");
    try { accessSync(file, constants.R_OK | constants.W_OK); }
    catch { throw new MonitorStateError("unwritable"); }
  }
}
