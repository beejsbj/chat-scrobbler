import { DeterministicCaptureError, TransientSyncError } from "./sync-errors";
import { fetchDetailJson, type FetchLike } from "./types";

/** Distinguish a forbidden chat from an expired or changed provider session. */
export async function fetchAuthenticatedDetail(fetcher: FetchLike, url: string, init: RequestInit | undefined,
  sessionStillValid: () => Promise<boolean>): Promise<unknown> {
  try { return await fetchDetailJson(fetcher, url, init); }
  catch (error) {
    if (!(error instanceof DeterministicCaptureError) || ![401, 403].includes(error.status ?? 0)) throw error;
    let valid = false;
    try { valid = await sessionStillValid(); }
    catch (verificationError) { if (verificationError instanceof TransientSyncError) throw verificationError; }
    if (!valid) throw new TransientSyncError("Provider session unavailable or changed; sign in and retry", error.status);
    throw error;
  }
}
