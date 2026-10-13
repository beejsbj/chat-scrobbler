import { assertStateOwner } from "./state-owner";
import { existsSync, rmSync } from "node:fs";
import { writeAtomicFile } from "../store/atomic-file";

/** Monitoring is best effort. A separate marker makes failed writes visible offline. */
export function monitorWrite(path: string, operation: () => void): void {
  try {
    operation();
    assertStateOwner(`${path}.fault`);
    rmSync(`${path}.fault`, { force: true });
  } catch {
    console.error(JSON.stringify({ event: "monitor_state_write_failed" }));
    try { assertStateOwner(`${path}.fault`); writeAtomicFile(`${path}.fault`, "write_failed\n"); } catch { /* Permissions are also checked by the monitor. */ }
  }
}

export function monitorWriteFailed(path: string): boolean {
  return existsSync(`${path}.fault`);
}
