import type { FetchLike } from "./types";
import { TransientSyncError } from "./sync-errors";

/** This permission belongs only to media read from the currently loaded Gemini DOM. */
export function isGeminiPageBlob(url: string, sourceId: string): boolean {
  return typeof location !== "undefined" && location.origin === "https://gemini.google.com"
    && location.pathname === `/app/${sourceId}`
    && /^blob:https:\/\/gemini\.google\.com\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(url);
}

export function validateGeminiPageBlobResponse(response: Response, url: string, sourceId: string): void {
  if (!isGeminiPageBlob(url, sourceId) || !response.ok || response.type === "opaqueredirect"
    || response.url && response.url !== url) throw new Error("asset_url_unavailable");
}

export async function fetchGeminiPageBlob(fetcher: FetchLike, url: string, sourceId: string): Promise<Response> {
  if (!isGeminiPageBlob(url, sourceId)) throw new Error("asset_url_unavailable");
  let response: Response;
  try { response = await fetcher(url, { credentials: "omit", redirect: "manual", signal: AbortSignal.timeout(60_000) }); }
  catch { throw new TransientSyncError("Page media blob unavailable"); }
  validateGeminiPageBlobResponse(response, url, sourceId);
  return response;
}
