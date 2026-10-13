import type { UploadedAsset } from "../../shared/src";
import type { AssetUploadRequest } from "./messages";
import { lookupAssetByHash } from "./asset-upload";

type Identity = Omit<AssetUploadRequest, "bytes"> & { sha256?: string | null };
const KEY = "scrobbler.assetPointerCache";
/** Paths, inline slots and ordinary URLs may change bytes without changing identity. */
function cacheKey(asset: Identity): string | null {
  const hash = /^(?:sha256:)?[a-f0-9]{64}$/.test(asset.pointer);
  const file = /^(?:(?:sediment|file-service):\/\/)?file[-_][A-Za-z0-9_-]+$/.test(asset.pointer);
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(asset.pointer);
  if (!hash && !(asset.source === "claude" ? uuid : file)) return null;
  return JSON.stringify([asset.source, asset.pointer]);
}
let writes = Promise.resolve();

export async function knownPointerAsset(fetcher: typeof fetch, settings: Parameters<typeof lookupAssetByHash>[1], asset: Identity) {
  const key = cacheKey(asset);
  if (!key) return null;
  const cache = await getCache();
  const pointerHash = asset.pointer.match(/^(?:sha256:)?([a-f0-9]{64})$/)?.[1];
  const sha256 = pointerHash ?? asset.sha256 ?? cache[key];
  if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) return null;
  // Always verify on the receiver: a local hint is insufficient after deletion or changing receivers.
  return lookupAssetByHash(fetcher, settings, asset, sha256);
}
export async function rememberPointer(asset: Identity, uploaded: UploadedAsset): Promise<void> {
  const key = cacheKey(asset);
  if (!key) return;
  if (!uploaded.sha256 || !/^[a-f0-9]{64}$/.test(uploaded.sha256)) return;
  const write = writes.catch(() => {}).then(async () => {
    const cache = await getCache();
    cache[key] = uploaded.sha256!;
    for (const key of Object.keys(cache).slice(0, Math.max(0, Object.keys(cache).length - 5000))) delete cache[key];
    await new Promise<void>(resolve => chrome.storage.local.set({ [KEY]: cache }, resolve));
  });
  writes = write;
  await write;
}
function getCache(): Promise<Record<string, string>> {
  return new Promise(resolve => chrome.storage.local.get(KEY, (values: Record<string, any>) => resolve(values[KEY] ?? {})));
}
