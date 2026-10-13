const KEY = "scrobbler.installId";
let pending: Promise<unknown> = Promise.resolve();

/** Serialize initialization so concurrent provider reports share one persistent id. */
export function getInstallId(): Promise<string> {
  const result = pending.catch(() => {}).then(async () => {
    const stored = await new Promise<Record<string, any>>(resolve => chrome.storage.local.get(KEY, resolve));
    if (typeof stored[KEY] === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(stored[KEY])) return stored[KEY];
    const id = crypto.randomUUID();
    await new Promise<void>(resolve => chrome.storage.local.set({ [KEY]: id }, resolve));
    return id;
  });
  pending = result;
  return result;
}
