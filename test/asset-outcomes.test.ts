import { expect, spyOn, test } from "bun:test";
import { DEFAULT_SYNC_PERIOD_MINUTES } from "../packages/shared/src";
import { uploadProviderAssets, type ProviderAssetCandidate } from "../packages/extension/src/providers/assets";
import {
  assetOutcomeKey, createAssetOutcomeMemory, nextAssetOutcome, reportablePointer, skipRememberedAttempt,
  transientRetryDelayMs, type AssetOutcomeMemory,
} from "../packages/extension/src/providers/asset-outcomes";

/** chrome.storage.local shim: the memory must survive a fresh module-level caller, so state lives here. */
function installChrome(storage: Record<string, any>) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, writable: true, value: { storage: { local: {
    get: (key: string | null, done: any) => done(key === null ? { ...storage } : { [key]: storage[key] }),
    set: (values: any, done: any) => { Object.assign(storage, values); done(); },
    remove: (key: string, done: any) => { delete storage[key]; done(); },
  } } } });
  return () => { if (saved) Object.defineProperty(globalThis, "chrome", saved); else delete (globalThis as any).chrome; };
}

const gone = (pointer: string, status = 404): ProviderAssetCandidate => ({ source: "chatgpt", sourceId: "conv", messageId: "m1", pointer, url: `/backend-api/files/${pointer}/download` });

async function run(memory: AssetOutcomeMemory | null, candidates: ProviderAssetCandidate[], responder: () => Response, extra: Record<string, unknown> = {}) {
  const failures: any[] = [];
  let fetches = 0;
  const uploaded = await uploadProviderAssets(async () => { fetches++; return responder(); }, async request => ({ pointer: request.pointer, local_path: "assets/chatgpt/conv/hash.bin", sha256: "a".repeat(64) }),
    candidates, { beforeFetch: async () => {}, reportFailure: async f => { failures.push(f); }, outcomes: memory, ...extra });
  return { failures, fetches, uploaded };
}

test("an expired asset is fetched and reported once, then skipped silently on later captures", async () => {
  const storage: Record<string, any> = {};
  const restore = installChrome(storage);
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const first = await run(createAssetOutcomeMemory(), [gone("file-1")], () => new Response("", { status: 404 }));
    expect(first.fetches).toBe(1);
    expect(first.failures).toMatchObject([{ reason: "asset_expired", pointer: "file-1", message_id: "m1" }]);
    for (let pass = 0; pass < 3; pass++) {
      const next = await run(createAssetOutcomeMemory(), [gone("file-1")], () => new Response("", { status: 404 }));
      expect(next.fetches).toBe(0);
      expect(next.failures).toEqual([]);
    }
    expect(JSON.stringify(log.mock.calls)).not.toContain("file-1");
  } finally { log.mockRestore(); restore(); }
});

test("a pointer that never had a download URL is reported once, then backs off", async () => {
  const storage: Record<string, any> = {};
  const restore = installChrome(storage);
  try {
    const candidate: ProviderAssetCandidate = { source: "gemini", sourceId: "g1", messageId: "r1", pointer: "opaque-id", url: null };
    const first = await run(createAssetOutcomeMemory(), [candidate], () => { throw new Error("no fetch"); });
    expect(first.failures).toMatchObject([{ reason: "asset_url_unavailable", pointer: "opaque-id" }]);
    const second = await run(createAssetOutcomeMemory(), [candidate], () => { throw new Error("no fetch"); });
    expect(second.failures).toEqual([]);
  } finally { restore(); }
});

test("a transient download failure is retried only after its backoff window, and a success clears it", async () => {
  const storage: Record<string, any> = {};
  const restore = installChrome(storage);
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  try {
    let status = 500;
    const responder = () => new Response(status === 200 ? new Uint8Array([137, 80, 78, 71]) : "", { status, headers: { "content-type": "image/png" } });
    const first = await run(createAssetOutcomeMemory(), [gone("file-2")], responder);
    expect(first.failures).toMatchObject([{ reason: "asset_download_failed" }]);
    now += transientRetryDelayMs(1) - 1000;
    const tooSoon = await run(createAssetOutcomeMemory(), [gone("file-2")], responder);
    expect(tooSoon).toMatchObject({ fetches: 0, failures: [] });
    now += 2000;
    const second = await run(createAssetOutcomeMemory(), [gone("file-2")], responder);
    expect(second.fetches).toBe(1);
    expect(second.failures).toMatchObject([{ reason: "asset_download_failed" }]);
    now += transientRetryDelayMs(2) + 1;
    status = 200;
    const recovered = await run(createAssetOutcomeMemory(), [gone("file-2")], responder);
    expect(recovered.uploaded).toHaveLength(1);
    expect(await createAssetOutcomeMemory().recall(assetOutcomeKey(gone("file-2")))).toBeNull();
  } finally { Date.now = originalNow; restore(); }
});

test("explicit backfill retries remembered assets while ordinary captures do not", async () => {
  const storage: Record<string, any> = {};
  const restore = installChrome(storage);
  try {
    await run(createAssetOutcomeMemory(), [gone("file-3")], () => new Response("", { status: 410 }));
    const ordinary = await run(createAssetOutcomeMemory(), [gone("file-3")], () => new Response("", { status: 410 }));
    expect(ordinary.fetches).toBe(0);
    const backfill = await run(createAssetOutcomeMemory(), [gone("file-3")], () => new Response("", { status: 410 }), { retryRemembered: true });
    expect(backfill.fetches).toBe(1);
    expect(backfill.failures).toMatchObject([{ reason: "asset_expired" }]);
  } finally { restore(); }
});

test("assets skipped behind a rate limit are reported but not pushed into backoff", async () => {
  const storage: Record<string, any> = {};
  const restore = installChrome(storage);
  try {
    const candidates = ["a", "b"].map(pointer => ({ source: "gemini" as const, sourceId: "c", pointer, url: `https://lh3.googleusercontent.com/${pointer}` }));
    const result = await run(createAssetOutcomeMemory(), candidates, () => new Response("", { status: 429, headers: { "retry-after": "60" } }));
    expect(result.failures).toHaveLength(2);
    const memory = createAssetOutcomeMemory();
    expect(await memory.recall(assetOutcomeKey(candidates[0]))).toMatchObject({ reason: "asset_download_failed", attempts: 1 });
    expect(await memory.recall(assetOutcomeKey(candidates[1]))).toBeNull();
  } finally { restore(); }
});

test("outside the extension no outcome memory is consulted, so unit tests stay independent", async () => {
  const candidate = gone("file-4");
  for (let pass = 0; pass < 2; pass++) {
    const result = await run(undefined as unknown as null, [candidate], () => new Response("", { status: 404 }));
    expect(result.fetches).toBe(1);
  }
});

test("outcome transitions: every reason backs off exponentially to a daily cap and never rests longer", () => {
  const now = 1_000_000;
  const hour = 3_600_000;
  for (const reason of ["asset_expired", "asset_url_unavailable", "asset_upload_failed", "asset_download_failed"] as const) {
    let outcome = nextAssetOutcome(null, reason, 100, now);
    expect(outcome).toMatchObject({ reason, attempts: 1, retry_after: now + 25 * 60_000 });
    const delays: number[] = [];
    for (let i = 0; i < 9; i++) { delays.push(outcome.retry_after! - now); outcome = nextAssetOutcome(outcome, reason, 100, now); }
    expect(delays.map(ms => ms / 60_000)).toEqual([25, 50, 100, 200, 400, 800, 1440, 1440, 1440]);
    expect(skipRememberedAttempt(outcome, now + 24 * hour - 1, 100, null)).toBe(true);
    expect(skipRememberedAttempt(outcome, now + 24 * hour, 100, null)).toBe(false);
    // Years later the asset is still retried: failure alone never ends retries.
    expect(skipRememberedAttempt(outcome, now + 365 * 24 * hour, 100, null)).toBe(false);
  }
  const tooLarge = nextAssetOutcome(null, "asset_too_large", 100, now);
  expect(skipRememberedAttempt(tooLarge, now, 100, null)).toBe(true);
  // A raised limit earns an immediate attempt; otherwise the ordinary backoff applies, not a 30 day rest.
  expect(skipRememberedAttempt(tooLarge, now, 101, null)).toBe(false);
  expect(skipRememberedAttempt(tooLarge, now + 30 * 60_000, 100, null)).toBe(false);
});

test("an entry written by the 30 day rest build wakes on the backoff schedule, not at its stored retry time", () => {
  const now = 1_000_000;
  const legacy = { reason: "asset_expired" as const, attempts: 2, last_attempt_at: now, retry_after: now + 30 * 24 * 3_600_000, max_bytes: null };
  expect(skipRememberedAttempt(legacy, now + 50 * 60_000 - 1, 100, null)).toBe(true);
  expect(skipRememberedAttempt(legacy, now + 50 * 60_000, 100, null)).toBe(false);
  const legacyTooLarge = { reason: "asset_too_large" as const, attempts: 1, last_attempt_at: now, retry_after: null, max_bytes: 100 };
  expect(skipRememberedAttempt(legacyTooLarge, now + 30 * 60_000, 100, null)).toBe(false);
});

test("a changed download input is a new asset attempt, an unchanged one waits out its backoff", () => {
  const now = 1_000_000;
  const entry = nextAssetOutcome(null, "asset_expired", 100, now, { input: "digest-a" });
  expect(skipRememberedAttempt(entry, now + 1000, 100, "digest-a")).toBe(true);
  expect(skipRememberedAttempt(entry, now + 1000, 100, "digest-b")).toBe(false);
  // Entries that predate input tracking have no recorded input, so a candidate that has one gets a fresh try.
  const old = { reason: "asset_expired" as const, attempts: 1, last_attempt_at: now, retry_after: now + 30 * 60_000, max_bytes: null };
  expect(skipRememberedAttempt(old, now + 1000, 100, null)).toBe(true);
  expect(skipRememberedAttempt(old, now + 1000, 100, "digest-a")).toBe(false);
});

test("a fresh download URL for the same pointer is fetched even while the old one is backing off", async () => {
  const storage: Record<string, any> = {};
  const restore = installChrome(storage);
  try {
    const candidate = (token: string): ProviderAssetCandidate => ({ source: "claude", sourceId: "conv", messageId: "m1", pointer: "file-uuid", url: `/api/organizations/o/files/file-uuid/download?sig=${token}` });
    const first = await run(createAssetOutcomeMemory(), [candidate("old")], () => new Response("", { status: 404 }));
    expect(first.failures).toMatchObject([{ reason: "asset_expired" }]);
    expect((await run(createAssetOutcomeMemory(), [candidate("old")], () => new Response("", { status: 404 }))).fetches).toBe(0);
    const fresh = await run(createAssetOutcomeMemory(), [candidate("new")], () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } }));
    expect(fresh.fetches).toBe(1);
    expect(fresh.uploaded).toHaveLength(1);
    expect(JSON.stringify(storage)).not.toContain("sig=");
  } finally { restore(); }
});

test("a repeated failure is retried again once its backoff ends, however many times it has failed", async () => {
  const storage: Record<string, any> = {};
  const restore = installChrome(storage);
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  try {
    const responder = () => new Response("", { status: 404 });
    for (let attempt = 1; attempt <= 12; attempt++) {
      const result = await run(createAssetOutcomeMemory(), [gone("file-5")], responder);
      expect(result.fetches).toBe(1);
      expect(result.failures).toMatchObject([{ reason: "asset_expired" }]);
      const wait = transientRetryDelayMs(attempt);
      now += wait - 1;
      expect((await run(createAssetOutcomeMemory(), [gone("file-5")], responder)).fetches).toBe(0);
      now += 1;
    }
    expect(transientRetryDelayMs(12)).toBe(24 * 3_600_000);
    expect(await createAssetOutcomeMemory().recall(assetOutcomeKey(gone("file-5")))).toMatchObject({ attempts: 12 });
  } finally { Date.now = originalNow; restore(); }
});

test("an asset the receiver reports as ignored is not attempted again by ordinary captures, whatever the elapsed time or URL", async () => {
  const storage: Record<string, any> = {};
  const restore = installChrome(storage);
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  try {
    const first = await run(createAssetOutcomeMemory(), [gone("file-6")], () => new Response("", { status: 404 }), { reportFailure: async () => ({ ignored: true }) });
    expect(first.fetches).toBe(1);
    expect(await createAssetOutcomeMemory().recall(assetOutcomeKey(gone("file-6")))).toMatchObject({ ignored: true });
    now += 400 * 24 * 3_600_000;
    const later = await run(createAssetOutcomeMemory(), [gone("file-6")], () => new Response("", { status: 404 }));
    expect(later).toMatchObject({ fetches: 0, failures: [] });
    const changedUrl = await run(createAssetOutcomeMemory(), [{ ...gone("file-6"), url: "/backend-api/files/file-6/download?fresh=1" }], () => new Response("", { status: 404 }));
    expect(changedUrl.fetches).toBe(0);
    // The receiver leaves ignored assets out of backfill pages, so an explicit backfill candidate is not ignored there.
    const backfill = await run(createAssetOutcomeMemory(), [gone("file-6")], () => new Response("", { status: 404 }), { retryRemembered: true });
    expect(backfill.fetches).toBe(1);
    expect(await createAssetOutcomeMemory().recall(assetOutcomeKey(gone("file-6")))).toMatchObject({ ignored: false, attempts: 2 });
  } finally { Date.now = originalNow; restore(); }
});

test("a receiver that does not know about ignores (older build) never marks an asset ignored", async () => {
  const storage: Record<string, any> = {};
  const restore = installChrome(storage);
  try {
    await run(createAssetOutcomeMemory(), [gone("file-7")], () => new Response("", { status: 404 }), { reportFailure: async () => undefined });
    await run(createAssetOutcomeMemory(), [gone("file-8")], () => new Response("", { status: 404 }), { reportFailure: async () => ({}) });
    for (const pointer of ["file-7", "file-8"]) expect((await createAssetOutcomeMemory().recall(assetOutcomeKey(gone(pointer))))!.ignored).toBeFalsy();
  } finally { restore(); }
});

test("long pointers are reported as a digest so status bodies and records stay bounded", async () => {
  expect(await reportablePointer("file-1")).toBe("file-1");
  const long = `data:image/png;base64,${"A".repeat(5000)}`;
  const reported = await reportablePointer(long);
  expect(reported).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(await reportablePointer(long)).toBe(reported);
});

test("the storage-backed memory evicts its oldest entries past the cap", async () => {
  const storage: Record<string, any> = {};
  const restore = installChrome(storage);
  try {
    const memory = createAssetOutcomeMemory(3);
    for (let i = 0; i < 5; i++) await memory.remember(`k${i}`, "asset_expired", 100, 1000 + i);
    expect(await memory.recall("k0")).toBeNull();
    expect(await memory.recall("k1")).toBeNull();
    expect(await memory.recall("k4")).toMatchObject({ reason: "asset_expired" });
    await memory.forget("k4");
    expect(await memory.recall("k4")).toBeNull();
  } finally { restore(); }
});

test("a failure the receiver never heard about earns no backoff, so the next pass retries it", async () => {
  const storage: Record<string, any> = {};
  const restore = installChrome(storage);
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    let fetches = 0;
    const receiverDown = await uploadProviderAssets(async () => { fetches++; return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } }); },
      async () => { throw new Error("receiver unreachable"); }, [gone("file-9")],
      { beforeFetch: async () => {}, reportFailure: async () => { throw new Error("receiver unreachable"); }, outcomes: createAssetOutcomeMemory() });
    expect(receiverDown).toEqual([]);
    expect(await createAssetOutcomeMemory().recall(assetOutcomeKey(gone("file-9")))).toBeNull();
    const recovered = await run(createAssetOutcomeMemory(), [gone("file-9")], () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } }));
    expect(recovered.fetches).toBe(1);
    expect(recovered.uploaded).toHaveLength(1);
    expect(fetches).toBe(1);
  } finally { log.mockRestore(); restore(); }
});

test("outcomes are stored one per asset under bounded hashed keys, never holding the pointer", async () => {
  const storage: Record<string, any> = { "scrobbler.settings": { keep: true } };
  const restore = installChrome(storage);
  try {
    const pointer = `data:image/png;base64,${"A".repeat(200_000)}`;
    const memory = createAssetOutcomeMemory();
    const key = assetOutcomeKey({ source: "gemini", sourceId: "g1", messageId: "r1", pointer });
    await memory.remember(key, "asset_url_unavailable", 100);
    await memory.remember(assetOutcomeKey(gone("file-2")), "asset_expired", 100);
    const outcomeKeys = Object.keys(storage).filter(k => k !== "scrobbler.settings");
    expect(outcomeKeys).toHaveLength(2);
    for (const k of outcomeKeys) expect(k.length).toBeLessThan(120);
    expect(JSON.stringify(storage).length).toBeLessThan(2_000);
    expect(await createAssetOutcomeMemory().recall(key)).toMatchObject({ reason: "asset_url_unavailable" });
    await memory.forget(key);
    expect(await memory.recall(key)).toBeNull();
    expect(storage["scrobbler.settings"]).toEqual({ keep: true });
  } finally { restore(); }
});

test("a successful upload clears an outcome another capture path recorded after this one looked", async () => {
  const forgotten: string[] = [];
  const memory: AssetOutcomeMemory = { recall: async () => null, remember: async () => {}, forget: async key => { forgotten.push(key); } };
  const ok = await run(memory, [gone("file-3")], () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } }));
  expect(ok.uploaded).toHaveLength(1);
  expect(forgotten).toEqual([assetOutcomeKey(gone("file-3"))]);
});

test("a login page or off-allowlist redirect in place of the asset backs off like any other failure", async () => {
  const storage: Record<string, any> = {};
  const restore = installChrome(storage);
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const responders: Array<[string, () => Response]> = [
      ["html", () => new Response("<!doctype html><title>Sign in</title>", { headers: { "content-type": "text/html" } })],
      ["json", () => new Response("{\"error\":\"unusual traffic\"}", { headers: { "content-type": "application/octet-stream" } })],
      ["redirect", () => new Response(null, { status: 302, headers: { location: "https://accounts.example.com/login" } })],
    ];
    for (const [pointer, responder] of responders) {
      const first = await run(createAssetOutcomeMemory(), [gone(pointer)], responder);
      expect(first.failures).toMatchObject([{ reason: "asset_download_failed", pointer }]);
      const remembered = await createAssetOutcomeMemory().recall(assetOutcomeKey(gone(pointer)));
      expect(remembered!.retry_after! - remembered!.last_attempt_at).toBe(transientRetryDelayMs(1));
    }
  } finally { log.mockRestore(); restore(); }
});

test("an outcome memory that cannot read or write never stops the rest of the batch", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const broken: AssetOutcomeMemory = {
      recall: async () => { throw new TypeError("storage gone"); },
      remember: async () => { throw new Error("Extension context invalidated."); },
      forget: async () => { throw new Error("storage gone"); },
    };
    let call = 0;
    const result = await run(broken, [gone("file-a"), gone("file-b")], () => call++ === 0
      ? new Response("", { status: 404 })
      : new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } }));
    expect(result.fetches).toBe(2);
    expect(result.failures).toMatchObject([{ reason: "asset_expired", pointer: "file-a" }]);
    expect(result.uploaded).toHaveLength(1);
  } finally { log.mockRestore(); }
});

test("the first transient retry lands on the next sync pass after one period, not the one after", () => {
  const syncPeriodMs = DEFAULT_SYNC_PERIOD_MINUTES * 60 * 1000;
  expect(transientRetryDelayMs(1)).toBeLessThan(syncPeriodMs);
  expect(transientRetryDelayMs(1)).toBeGreaterThanOrEqual(syncPeriodMs - 10 * 60 * 1000);
  expect(transientRetryDelayMs(2)).toBe(2 * transientRetryDelayMs(1));
});

test("an outcome stamped in the future (clock jumped forward, then corrected) no longer holds the asset back", () => {
  const now = 1_000_000_000_000;
  const entry = { ...nextAssetOutcome(null, "asset_download_failed", 1000, now + 5 * 24 * 3_600_000), retry_after: null };
  expect(skipRememberedAttempt(entry, now, 1000, null)).toBe(false);
  expect(skipRememberedAttempt({ ...entry, last_attempt_at: now }, now + 1000, 1000, null)).toBe(true);
  // The owner's ignore is a decision, not a schedule: a future stamp does not undo it.
  expect(skipRememberedAttempt({ ...entry, ignored: true }, now, 1000, null)).toBe(true);
});
