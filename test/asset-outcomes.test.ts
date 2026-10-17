import { expect, spyOn, test } from "bun:test";
import { uploadProviderAssets, type ProviderAssetCandidate } from "../packages/extension/src/providers/assets";
import {
  assetOutcomeKey, createAssetOutcomeMemory, nextAssetOutcome, reportablePointer, skipRememberedAttempt,
  transientRetryDelayMs, type AssetOutcomeMemory,
} from "../packages/extension/src/providers/asset-outcomes";

/** chrome.storage.local shim: the memory must survive a fresh module-level caller, so state lives here. */
function installChrome(storage: Record<string, any>) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, writable: true, value: { storage: { local: {
    get: (key: string, done: any) => done({ [key]: storage[key] }),
    set: (values: any, done: any) => { Object.assign(storage, values); done(); },
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

test("a pointer that never had a download URL is terminal after one report", async () => {
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

test("outcome transitions: terminal reasons rest for 30 days, transient backoff doubles to a daily cap", () => {
  const now = 1_000_000;
  const day = 24 * 3_600_000;
  for (const reason of ["asset_expired", "asset_url_unavailable"] as const) {
    const terminal = nextAssetOutcome(null, reason, 100, now);
    expect(terminal).toMatchObject({ reason, attempts: 1, retry_after: now + 30 * day });
    expect(skipRememberedAttempt(terminal, now + 30 * day - 1, 100)).toBe(true);
    expect(skipRememberedAttempt(terminal, now + 30 * day, 100)).toBe(false);
    // A repeat failure rests another full 30 days rather than escalating.
    expect(nextAssetOutcome(terminal, reason, 100, now + 30 * day).retry_after).toBe(now + 60 * day);
  }
  // Entries written without a retry time still age out from their last attempt.
  const legacy = { reason: "asset_expired" as const, attempts: 1, last_attempt_at: now, retry_after: null, max_bytes: null };
  expect(skipRememberedAttempt(legacy, now + 29 * day, 100)).toBe(true);
  expect(skipRememberedAttempt(legacy, now + 30 * day, 100)).toBe(false);
  let transient = nextAssetOutcome(null, "asset_upload_failed", 100, now);
  expect(transient.retry_after).toBe(now + 30 * 60_000);
  for (let i = 0; i < 10; i++) transient = nextAssetOutcome(transient, "asset_upload_failed", 100, now);
  expect(transient.attempts).toBe(11);
  expect(transient.retry_after).toBe(now + 24 * 3_600_000);
  expect(skipRememberedAttempt(transient, now + 23 * 3_600_000, 100)).toBe(true);
  expect(skipRememberedAttempt(transient, now + 24 * 3_600_000, 100)).toBe(false);
  const tooLarge = nextAssetOutcome(null, "asset_too_large", 100, now);
  expect(skipRememberedAttempt(tooLarge, now, 100)).toBe(true);
  expect(skipRememberedAttempt(tooLarge, now, 101)).toBe(false);
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

test("a remembered expired asset is attempted again once its 30 day rest ends", async () => {
  const storage: Record<string, any> = {};
  const restore = installChrome(storage);
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  try {
    const responder = () => new Response("", { status: 404 });
    expect((await run(createAssetOutcomeMemory(), [gone("file-5")], responder)).fetches).toBe(1);
    now += 29 * 24 * 3_600_000;
    expect(await run(createAssetOutcomeMemory(), [gone("file-5")], responder)).toMatchObject({ fetches: 0, failures: [] });
    now += 24 * 3_600_000;
    const retried = await run(createAssetOutcomeMemory(), [gone("file-5")], responder);
    expect(retried.fetches).toBe(1);
    expect(retried.failures).toMatchObject([{ reason: "asset_expired" }]);
    expect(await createAssetOutcomeMemory().recall(assetOutcomeKey(gone("file-5")))).toMatchObject({ attempts: 2 });
  } finally { Date.now = originalNow; restore(); }
});
