import type { DetailFailureIdentity } from "../../../shared/src";
import { abortTransientCapture, ProviderDetailError, ProviderDetailOutageError } from "./sync-errors";

const key = (f: DetailFailureIdentity) => JSON.stringify([f.source_id, f.updated_at]);
/** Learn suspect identities on abort; repeated identities can count when other chats work. */
export class DetailFailureStreak {
  private previous: Set<string>;
  private remembered: Map<string, DetailFailureIdentity>;
  private consecutive: DetailFailureIdentity[] = [];
  private failedThisRun = new Set<string>();
  private confirmed: Set<string>;
  private healthy = false;
  constructor(previous: DetailFailureIdentity[] = []) {
    this.previous = new Set(previous.map(key));
    this.confirmed = new Set(previous.filter(f => f.confirmed_local).map(key));
    this.remembered = new Map(previous.map(f => [key(f), { ...f }]));
  }
  succeeded(id: string): void {
    this.healthy = true;
    this.consecutive = [];
    for (const [k, f] of this.remembered) if (f.source_id === id) this.remembered.delete(k);
  }
  failed(error: unknown, id: string, updatedAt: string | null): void {
    abortTransientCapture(error);
    if (!(error instanceof ProviderDetailError) || error.status! < 500) { this.succeeded(id); return; }
    const identity = { source_id: id, updated_at: updatedAt };
    this.consecutive.push(identity);
    this.failedThisRun.add(key(identity));
    this.remembered.set(key(identity), { ...this.remembered.get(key(identity)), ...identity });
    if (this.consecutive.length >= 3 && this.consecutive.some(f => !this.previous.has(key(f)))) {
      throw new ProviderDetailOutageError(this.snapshot());
    }
  }
  finish(): void {
    // No working detail response and no earlier confirmation remains environmental.
    if (!this.healthy && this.failedThisRun.size >= 3 && [...this.failedThisRun].some(k => !this.confirmed.has(k))) {
      throw new ProviderDetailOutageError(this.snapshot());
    }
    if (this.healthy) for (const k of this.failedThisRun) {
      const identity = this.remembered.get(k);
      if (identity) identity.confirmed_local = true;
    }
  }
  snapshot(): DetailFailureIdentity[] { return [...this.remembered.values()].slice(-5000); }
}
