import { beforeAll, beforeEach, expect, test } from "bun:test";
import { buildRawCapture } from "../packages/shared/src";
import type { RuntimeMessage } from "../packages/extension/src/messages";

type RuntimeListener = (message: RuntimeMessage, sender: unknown, sendResponse: (response: unknown) => void) => boolean;

const storageData: Record<string, unknown> = {};
let runtimeListener: RuntimeListener | null = null;

beforeAll(async () => {
  installChromeStub();
  await import("../packages/extension/src/background");
});

beforeEach(() => {
  for (const key of Object.keys(storageData)) delete storageData[key];
  globalThis.fetch = (async () => {
    throw new Error("unexpected fetch");
  }) as unknown as typeof fetch;
});

test("background reports ignored postCapture as not captured", async () => {
  storageData["scrobbler.ignoredChats"] = ["chatgpt:ignored-late"];
  const fetches: string[] = [];
  globalThis.fetch = (async (input) => {
    fetches.push(String(input));
    return Response.json({ ok: true });
  }) as typeof fetch;

  const response = await sendRuntimeMessage({
    type: "SCROBBLER_CAPTURE_READY",
    capture: buildRawCapture({
      source: "chatgpt",
      sourceId: "ignored-late",
      endpoint: "/backend-api/conversation/ignored-late",
      payload: { id: "ignored-late" },
      conversationUpdatedAt: "2026-06-05T12:00:00.000Z",
    }),
  });

  expect(response).toEqual({ ok: false, captured: false, ignored: true, error: "Capture ignored" });
  expect(fetches).toEqual([]);
});

test("background omits ignored conversations from status requests and returns ignored locally", async () => {
  storageData["scrobbler.ignoredChats"] = ["chatgpt:ignored"];
  const statusBodies: unknown[] = [];
  globalThis.fetch = (async (input, init) => {
    expect(String(input)).toBe("http://127.0.0.1:4318/status");
    statusBodies.push(JSON.parse(String(init?.body)));
    return Response.json({ statuses: { active: "synced" } });
  }) as typeof fetch;

  const response = await sendRuntimeMessage({
    type: "SCROBBLER_CONVERSATION_STATES",
    provider: "chatgpt",
    conversations: [
      { id: "ignored", updatedAt: "2026-06-05T12:00:00.000Z" },
      { id: "active", updatedAt: "2026-06-05T11:00:00.000Z" },
    ],
  });

  expect(statusBodies).toEqual([
    {
      source: "chatgpt",
      conversations: [{ id: "active", updated_at: "2026-06-05T11:00:00.000Z" }],
    },
  ]);
  expect(response).toEqual({ ok: true, statuses: { active: "synced", ignored: "ignored" } });
});

test("background ignores chats after successful delete capture only", async () => {
  const deletes: string[] = [];
  globalThis.fetch = (async (input) => {
    deletes.push(String(input));
    if (String(input).includes("failed-delete")) {
      return new Response("not deleted", { status: 500 });
    }
    return Response.json({ deleted: true });
  }) as typeof fetch;

  const deletedResponse = await sendRuntimeMessage({
    type: "SCROBBLER_DELETE_CAPTURE",
    provider: "chatgpt",
    id: "deleted-chat",
  });

  expect(deletedResponse).toEqual({ ok: true, delete: { deleted: true } });
  expect(storageData["scrobbler.ignoredChats"]).toEqual(["chatgpt:deleted-chat"]);

  const failedResponse = await sendRuntimeMessage({
    type: "SCROBBLER_DELETE_CAPTURE",
    provider: "chatgpt",
    id: "failed-delete",
  });

  expect(failedResponse).toEqual({ ok: false, error: "Delete request failed with HTTP 500: not deleted" });
  expect(storageData["scrobbler.ignoredChats"]).toEqual(["chatgpt:deleted-chat"]);
  expect(deletes).toEqual([
    "http://127.0.0.1:4318/captures?source=chatgpt&source_id=deleted-chat",
    "http://127.0.0.1:4318/captures?source=chatgpt&source_id=failed-delete",
  ]);
});

test("background saves and reports ingest token settings", async () => {
  const saveResponse = await sendRuntimeMessage({
    type: "SCROBBLER_SAVE_SETTINGS",
    ingestBaseUrl: "https://receiver.example",
    ingestToken: "secret-token",
    autoSync: false,
  });

  expect(saveResponse).toMatchObject({
    ok: true,
    settings: {
      ingestBaseUrl: "https://receiver.example",
      ingestToken: "secret-token",
      autoSync: false,
    },
  });

  const statusResponse = await sendRuntimeMessage({ type: "SCROBBLER_GET_STATUS" });
  expect(statusResponse).toMatchObject({
    ok: true,
    settings: {
      ingestBaseUrl: "https://receiver.example",
      ingestToken: "secret-token",
      autoSync: false,
    },
  });
});

function sendRuntimeMessage(message: RuntimeMessage): Promise<unknown> {
  return new Promise((resolve) => {
    expect(runtimeListener).not.toBeNull();
    const keepAlive = runtimeListener!(message, {}, resolve);
    expect(keepAlive).toBe(true);
  });
}

function installChromeStub(): void {
  const addRuntimeListener = (listener: RuntimeListener) => {
    runtimeListener = listener;
  };
  const addListener = () => undefined;
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    writable: true,
    value: {
      action: {
        setBadgeBackgroundColor: () => undefined,
        setBadgeText: () => undefined,
        setIcon: () => undefined,
      },
      alarms: {
        create: () => undefined,
        onAlarm: { addListener },
      },
      runtime: {
        onInstalled: { addListener },
        onMessage: { addListener: addRuntimeListener },
        onStartup: { addListener },
      },
      storage: {
        local: {
          get: (key: string, callback: (value: Record<string, unknown>) => void) => {
            callback({ [key]: storageData[key] });
          },
          set: (value: Record<string, unknown>, callback: () => void) => {
            Object.assign(storageData, value);
            callback();
          },
        },
      },
      tabs: {
        onRemoved: { addListener },
        query: (_query: unknown, callback: (tabs: unknown[]) => void) => callback([]),
        sendMessage: (_tabId: number, _message: unknown, callback: (response: unknown) => void) => callback(undefined),
      },
    },
  });
}

test("background forwards asset failure reports to authenticated status endpoint", async () => {
  storageData["scrobbler.settings"] = { ingestBaseUrl: "http://local:4318", ingestToken: "test-token" };
  const reports: unknown[] = [];
  globalThis.fetch = (async (input, init) => {
    expect(String(input)).toBe("http://local:4318/status");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer test-token");
    reports.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true });
  }) as typeof fetch;
  expect(await sendRuntimeMessage({ type: "SCROBBLER_ASSET_FAILURE", failure: { source: "chatgpt", source_id: "conv", message_id: "m1", reason: "asset_upload_failed" } })).toMatchObject({ ok: true });
  expect(reports).toEqual([{ source: "chatgpt", conversations: [], asset_failures: [{ source_id: "conv", message_id: "m1", reason: "asset_upload_failed" }] }]);
});

test("background treats server deletion skips as uncaptured without incrementing posted counts", async () => {
  const ingest = { ok: true, count: 0, skipped_deleted: [{ source: "chatgpt", source_id: "gone" }] };
  globalThis.fetch = (async () => Response.json(ingest)) as unknown as typeof fetch;
  const response = await sendRuntimeMessage({ type: "SCROBBLER_CAPTURE_READY", capture: buildRawCapture({ source: "chatgpt", sourceId: "gone", endpoint: "/detail", payload: {} }) });
  expect(response).toMatchObject({ ok: true, captured: false, ingest });
  expect((storageData["scrobbler.status"] as { capturesPosted?: number } | undefined)?.capturesPosted ?? 0).toBe(0);
});

test("background checks SHA-256 and references existing blobs without uploading bytes", async () => {
  const calls: Array<{ method: string; url: string; body?: BodyInit | null }> = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({ method: init?.method ?? "GET", url: String(input), body: init?.body });
    if (String(input).includes("/reference?")) {
      expect(init?.body).toBeUndefined();
      return Response.json({ ok: true, pointer: "p", local_path: "assets/claude/c/hash.png", sha256: "hash" });
    }
    return Response.json({ ok: true, exists: true });
  }) as typeof fetch;
  expect(await sendRuntimeMessage({ type: "SCROBBLER_ASSET_UPLOAD", asset: { source: "claude", sourceId: "c", pointer: "p", bytes: [1, 2, 3], contentType: "image/png" } })).toMatchObject({ ok: true });
  expect(calls).toHaveLength(2);
  expect(new URL(calls[0].url).searchParams.get("sha256")).toBe("039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81");
  expect(calls[1].url).toContain("/assets/reference?");
});

test("background falls back to uploading bytes when an old server has no hash lookup", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input, init) => {
    calls.push(init?.method ?? "GET");
    if (!init?.method) return new Response("", { status: 404 });
    expect(Array.from(init.body as Uint8Array)).toEqual([1, 2]);
    return Response.json({ ok: true, pointer: "p", local_path: "assets/claude/c/hash" });
  }) as typeof fetch;
  expect(await sendRuntimeMessage({ type: "SCROBBLER_ASSET_UPLOAD", asset: { source: "claude", sourceId: "c", pointer: "p", bytes: [1, 2] } })).toMatchObject({ ok: true });
  expect(calls).toEqual(["GET", "POST"]);
});

test("background persists the configurable asset size limit", async () => {
  expect(await sendRuntimeMessage({ type: "SCROBBLER_SAVE_SETTINGS", ingestBaseUrl: "http://local", maxAssetBytes: 7 })).toMatchObject({ settings: { maxAssetBytes: 7 } });
  expect(await sendRuntimeMessage({ type: "SCROBBLER_ASSET_UPLOAD", asset: { source: "claude", sourceId: "c", pointer: "p", bytes: [1, 2, 3, 4, 5, 6, 7, 8] } })).toMatchObject({ ok: false, error: "asset_too_large" });
});

test("background assembles bounded asset chunks before hash lookup and upload", async () => {
  let uploaded: number[] | undefined;
  globalThis.fetch = (async (_input, init) => {
    if (!init?.method) return Response.json({ ok: true, exists: false });
    uploaded = Array.from(init.body as Uint8Array);
    return Response.json({ ok: true, pointer: "p", local_path: "assets/chatgpt/c/hash" });
  }) as typeof fetch;
  const start = await sendRuntimeMessage({ type: "SCROBBLER_ASSET_UPLOAD_START", asset: { source: "chatgpt", sourceId: "c", pointer: "p" }, sizeBytes: 3 }) as any;
  expect(start.ok).toBe(true);
  expect(await sendRuntimeMessage({ type: "SCROBBLER_ASSET_UPLOAD_CHUNK", uploadId: start.uploadId, offset: 0, bytes: [1, 2] })).toMatchObject({ ok: true });
  expect(await sendRuntimeMessage({ type: "SCROBBLER_ASSET_UPLOAD_CHUNK", uploadId: start.uploadId, offset: 2, bytes: [3] })).toMatchObject({ ok: true });
  expect(await sendRuntimeMessage({ type: "SCROBBLER_ASSET_UPLOAD_FINISH", uploadId: start.uploadId })).toMatchObject({ ok: true });
  expect(uploaded).toEqual([1, 2, 3]);
});

test("background rejects asset URLs outside provider hosts before fetching", async () => {
  let fetched = false;
  globalThis.fetch = (async () => { fetched = true; return new Response("private"); }) as unknown as typeof fetch;
  expect(await sendRuntimeMessage({ type: "SCROBBLER_ASSET_FETCH", url: "http://127.0.0.1/private" })).toMatchObject({ ok: false });
  expect(await sendRuntimeMessage({ type: "SCROBBLER_ASSET_FETCH", url: "https://unrelated.example/private" })).toMatchObject({ ok: false });
  expect(fetched).toBe(false);
});

test("background media fetch rejects cross-provider and auth-document probes", async () => {
  let uploads = 0;
  const asset = { source: "gemini" as const, sourceId: "c", pointer: "p" };
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes("/assets")) { uploads++; return Response.json({ ok: true }); }
    expect(init?.redirect).toBe("manual");
    expect(init?.credentials).toBe("include");
    return new Response('{"accessToken":"SECRET"}', { headers: { "content-type": "image/png" } });
  }) as typeof fetch;
  expect(await sendRuntimeMessage({ type: "SCROBBLER_ASSET_FETCH", url: "https://claude.ai/api/organizations/org/files/f/download", upload: asset })).toMatchObject({ ok: false });
  expect(await sendRuntimeMessage({ type: "SCROBBLER_ASSET_FETCH", url: "https://lh3.googleusercontent.com/gg-dl/image", upload: asset })).toMatchObject({ ok: false });
  expect(uploads).toBe(0);
});

for (const status of [400, 401, 403, 404, 405, 407, 408, 409, 413, 422, 429, 500, 503]) test(`background carries ${status} capture rejection classification to the tab`, async () => {
  globalThis.fetch = (async () => new Response("rejected", { status })) as unknown as typeof fetch;
  const result = await sendRuntimeMessage({ type: "SCROBBLER_CAPTURE_READY", capture: buildRawCapture({ source: "chatgpt", sourceId: "c", endpoint: "/detail", payload: {} }) });
  expect(result).toMatchObject({ ok: false, error_type: [400, 413, 422].includes(status) ? "deterministic" : "transient" });
});

for (const identity of [
  { source: "chatgpt" as const, sourceId: "c", pointer: "sediment://file_immutable" },
  { source: "claude" as const, sourceId: "c", pointer: "a2532b3f-751b-4d54-8890-cb3e971ab982" },
  { source: "gemini" as const, sourceId: "c", pointer: "file-immutable" },
  { source: "gemini" as const, sourceId: "c", pointer: `sha256:${"a".repeat(64)}` },
]) test(`content-addressed ${identity.pointer} cache verifies receiver existence across sessions`, async () => {
  const hash = "a".repeat(64);
  const calls: Array<{ url: string; method: string; bytes: boolean }> = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", bytes: !!init?.body });
    if (!init?.method) return Response.json({ exists: calls.length > 2 });
    return Response.json({ pointer: "https://lh3.googleusercontent.com/voice", local_path: "assets/gemini/c/hash.wav", sha256: hash });
  }) as typeof fetch;
  await sendRuntimeMessage({ type: "SCROBBLER_ASSET_UPLOAD", asset: { ...identity, bytes: [1, 2] } });
  const result = await sendRuntimeMessage({ type: "SCROBBLER_ASSET_LOOKUP", asset: { ...identity, sourceId: "other" } });
  expect(result).toMatchObject({ ok: true, asset: { sha256: hash } });
  expect(calls).toHaveLength(4);
  expect(calls[2].url).toContain(`sha256=${hash}`);
  expect(calls[3]).toMatchObject({ method: "POST", bytes: false });
  expect(calls[3].url).toContain("/assets/reference?");
  expect(new URL(calls[3].url).searchParams.get("source_id")).toBe("other");
});

for (const mode of ["network", "server"] as const) test(`failure report ${mode} outage does not undo saved sync success`, async () => {
  const tabs = chrome.tabs as any;
  const oldQuery = tabs.query, oldSend = tabs.sendMessage;
  tabs.query = (_query: any, done: any) => done([{ id: 1, url: "https://chatgpt.com/" }]);
  tabs.sendMessage = (_id: any, _message: any, done: any) => done({ ok: true, source: "chatgpt", maxConversationUpdatedAt: "2026-06-05T12:00:00Z", captureFailures: [], captured: 1, skipped: 0, scanned: 1, account: null });
  globalThis.fetch = (async () => { if (mode === "network") throw new TypeError("offline"); return new Response("", { status: 500 }); }) as unknown as typeof fetch;
  try {
    expect(await sendRuntimeMessage({ type: "SCROBBLER_SYNC_ACTIVE_TAB" })).toMatchObject({ ok: true });
    expect((storageData["scrobbler.status"] as any).providers.chatgpt.lastSync).toBe("2026-06-05T12:00:00Z");
  } finally { tabs.query = oldQuery; tabs.sendMessage = oldSend; }
});

test("sync reports carry a stable per-install id, and a different installation gets another id", async () => {
  const tabs = chrome.tabs as any;
  const oldQuery = tabs.query, oldSend = tabs.sendMessage;
  tabs.query = (_query: any, done: any) => done([{ id: 1, url: "https://chatgpt.com/" }]);
  tabs.sendMessage = (_id: any, _message: any, done: any) => done({ ok: true, source: "chatgpt", captureFailures: [], captured: 0, skipped: 0, scanned: 0, account: null, maxConversationUpdatedAt: null });
  const ids: unknown[] = [];
  globalThis.fetch = (async (_input, init) => { ids.push(JSON.parse(String(init?.body)).install_id); return Response.json({ ok: true }); }) as typeof fetch;
  try {
    for (let i = 0; i < 2; i++) expect(await sendRuntimeMessage({ type: "SCROBBLER_SYNC_ACTIVE_TAB" })).toMatchObject({ ok: true });
    expect(ids[0]).toMatch(/^[a-f0-9-]{36}$/);
    expect(ids[1]).toBe(ids[0]);
    for (const key of Object.keys(storageData)) delete storageData[key];
    await sendRuntimeMessage({ type: "SCROBBLER_SYNC_ACTIVE_TAB" });
    expect(ids[2]).not.toBe(ids[0]);
  } finally { tabs.query = oldQuery; tabs.sendMessage = oldSend; }
});

test("an interrupted ingest acknowledgement remains an environmental failure", async () => {
  globalThis.fetch = (async () => new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("connection lost")); } }), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  expect(await sendRuntimeMessage({ type: "SCROBBLER_CAPTURE_READY", capture: buildRawCapture({ source: "chatgpt", sourceId: "c", endpoint: "/detail", payload: {} }) }))
    .toMatchObject({ ok: false, error_type: "transient" });
});

for (const secondConversation of ["convB", "convA"]) test(`sandbox path reuse in ${secondConversation} never links convA's old bytes`, async () => {
  const pointer = "sandbox:/mnt/data/plot.png";
  const hashA = "a".repeat(64), hashB = "b".repeat(64);
  let byteUploads = 0;
  globalThis.fetch = (async (_input, init) => {
    if (!init?.method) return Response.json({ exists: true });
    if (init.body) { byteUploads++; return Response.json({ pointer, sha256: byteUploads === 1 ? hashA : hashB, local_path: "assets/plot.png" }); }
    return Response.json({ pointer, sha256: hashA, local_path: "assets/plot.png" });
  }) as typeof fetch;
  const identity = { source: "chatgpt" as const, sourceId: "convA", pointer };
  expect(await sendRuntimeMessage({ type: "SCROBBLER_ASSET_UPLOAD", asset: { ...identity, bytes: [1] } })).toMatchObject({ ok: true });
  expect((storageData["scrobbler.assetPointerCache"] as Record<string, string> | undefined)?.[JSON.stringify([identity.source, pointer])]).toBeUndefined();
  // Include a legacy cache entry left by 0.4.1, to exercise upgrades as well as new writes.
  storageData["scrobbler.assetPointerCache"] = { [JSON.stringify([identity.source, pointer])]: hashA };
  const second = { ...identity, sourceId: secondConversation };
  expect(await sendRuntimeMessage({ type: "SCROBBLER_ASSET_LOOKUP", asset: second })).toMatchObject({ ok: true, asset: null });
  // The receiver already knows B's actual hash; byte dedup can still link B after a fresh download.
  globalThis.fetch = (async (_input, init) => init?.method
    ? Response.json({ pointer, sha256: hashB, local_path: "assets/new-plot.png" }) : Response.json({ exists: true })) as typeof fetch;
  expect(await sendRuntimeMessage({ type: "SCROBBLER_ASSET_UPLOAD", asset: { ...second, bytes: [2] } }))
    .toMatchObject({ ok: true, asset: { sha256: hashB } });
});

for (const pointer of ["/mnt/data/plot.png", "https://lh3.googleusercontent.com/gg-dl/mutable", "claude-inline:m:/content/1"]) test(`mutable ${pointer} is never reused from the pointer cache`, async () => {
  storageData["scrobbler.assetPointerCache"] = { [JSON.stringify(["gemini", pointer])]: "a".repeat(64) };
  let requests = 0;
  globalThis.fetch = (async () => { requests++; return Response.json({ exists: true }); }) as unknown as typeof fetch;
  expect(await sendRuntimeMessage({ type: "SCROBBLER_ASSET_LOOKUP", asset: { source: "gemini", sourceId: "c", pointer } })).toMatchObject({ ok: true, asset: null });
  expect(requests).toBe(0);
});

test("background follows only visible allowlisted media redirect hops and validates the final bytes", async () => {
  const mediaRequests: string[] = [];
  let uploads = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("/assets")) {
      if (!init?.method) return Response.json({ exists: false });
      uploads++;
      return Response.json({ pointer: "file-audio", local_path: "assets/audio", sha256: "a".repeat(64) });
    }
    mediaRequests.push(url);
    expect(init?.redirect).toBe("manual");
    expect(init?.credentials).toBe("include");
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    return mediaRequests.length === 1 ? new Response(null, { status: 302, headers: { location: "https://lh4.googleusercontent.com/media/audio" } })
      : new Response(new Uint8Array([7]), { headers: { "content-type": "audio/wav" } });
  }) as typeof fetch;
  expect(await sendRuntimeMessage({ type: "SCROBBLER_ASSET_FETCH", url: "https://lh3.googleusercontent.com/media/audio", upload: { source: "gemini", sourceId: "c", pointer: "file-audio" } })).toMatchObject({ ok: true });
  expect(mediaRequests).toEqual(["https://lh3.googleusercontent.com/media/audio", "https://lh4.googleusercontent.com/media/audio"]);
  expect(uploads).toBe(1);
});

for (const status of [401, 403, 404, 405, 407, 408]) test(`receiver ${status} aborts four syncs with no attempts and surfaces its error locally and through /status`, async () => {
  const { createChatgptAdapter } = await import("../packages/extension/src/providers/chatgpt");
  const { ReceiverSyncError, DeterministicCaptureError } = await import("../packages/extension/src/providers/sync-errors");
  const { syncErrorResponse } = await import("../packages/extension/src/sync-error-response");
  const tabs = chrome.tabs as any;
  const oldQuery = tabs.query, oldSend = tabs.sendMessage;
  const previous = { lastSync: "2026-06-04T00:00:00Z", captureFailures: [], lastError: null, lastResult: null, lastVisitSync: null };
  storageData["scrobbler.status"] = { capturesPosted: 0, providers: { chatgpt: previous }, lastCaptureAt: null };
  const reports: any[] = [];
  let details = 0;
  globalThis.fetch = (async (input, init) => {
    if (String(input).endsWith("/captures")) return new Response("rejected", { status });
    reports.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true });
  }) as typeof fetch;
  const adapter = createChatgptAdapter(async url => {
    if (url === "/api/auth/session") return Response.json({});
    if (url.includes("conversations?")) return Response.json({ items: ["a", "b"].map(id => ({ id, update_time: "2026-06-05T00:00:00Z" })) });
    details++;
    return Response.json({ mapping: {} });
  });
  tabs.query = (_query: any, done: any) => done([{ id: 1, url: "https://chatgpt.com/" }]);
  tabs.sendMessage = (_id: any, request: any, done: any) => {
    adapter.sync({ ...request, emitCapture: async capture => {
      const response = await sendRuntimeMessage({ type: "SCROBBLER_CAPTURE_READY", capture }) as any;
      if (!response.ok) throw response.error_type === "deterministic" ? new DeterministicCaptureError(response.error, status) : new ReceiverSyncError(response.error, status);
    } }).then(result => done({ ok: true, ...result }), error => done(syncErrorResponse(error)));
  };
  try {
    for (let run = 0; run < 4; run++) expect(await sendRuntimeMessage({ type: "SCROBBLER_SYNC_ACTIVE_TAB" })).toMatchObject({ ok: false });
    const current = (await sendRuntimeMessage({ type: "SCROBBLER_GET_STATUS" }) as any).status.providers.chatgpt;
    expect(current.captureFailures).toEqual([]);
    expect(current.lastSync).toBe(previous.lastSync);
    expect(current.lastError).toContain(String(status));
    expect(current.lastSyncError).toMatchObject({ reason: "receiver_unavailable", status });
    expect(details).toBe(4);
    expect(reports).toHaveLength(4);
    expect(reports[3]).toMatchObject({ capture_failures: [], last_sync_error: { reason: "receiver_unavailable", status } });
  } finally { tabs.query = oldQuery; tabs.sendMessage = oldSend; }
});

test("background persists a three-chat 500 cohort across four fresh adapter runs and releases the cursor", async () => {
  const { createChatgptAdapter } = await import("../packages/extension/src/providers/chatgpt");
  const { syncErrorResponse } = await import("../packages/extension/src/sync-error-response");
  const tabs = chrome.tabs as any;
  const oldQuery = tabs.query, oldSend = tabs.sendMessage;
  const cursor = "2026-06-04T00:00:00Z";
  storageData["scrobbler.status"] = { capturesPosted: 0, lastCaptureAt: null, providers: { chatgpt: { lastSync: cursor, captureFailures: [] } } };
  globalThis.fetch = (async () => Response.json({ ok: true })) as unknown as typeof fetch;
  const requestedStreaks: number[] = [];
  tabs.query = (_query: any, done: any) => done([{ id: 1, url: "https://chatgpt.com/" }]);
  tabs.sendMessage = (_id: any, request: any, done: any) => {
    requestedStreaks.push(request.detailFailureStreak.length);
    createChatgptAdapter(async url => {
      if (url === "/api/auth/session") return Response.json({});
      if (url.includes("conversations?")) return Response.json({ items: ["a", "b", "c", "good"].map(id => ({ id, update_time: "2026-06-05T00:00:00Z" })) });
      return url.endsWith("/good") ? Response.json({ mapping: {} }) : new Response("permanent", { status: 500 });
    }).sync({ ...request, emitCapture: async () => {} }).then(result => done({ ok: true, ...result }), error => done(syncErrorResponse(error)));
  };
  try {
    for (let run = 0; run < 4; run++) {
      expect(await sendRuntimeMessage({ type: "SCROBBLER_SYNC_ACTIVE_TAB" })).toMatchObject({ ok: run !== 0 });
      const state = (storageData["scrobbler.status"] as any).providers.chatgpt;
      expect(state.captureFailures.every((f: any) => f.attempts === run)).toBe(true);
      storageData["scrobbler.status"] = JSON.parse(JSON.stringify(storageData["scrobbler.status"]));
    }
    const state = (storageData["scrobbler.status"] as any).providers.chatgpt;
    expect(requestedStreaks).toEqual([0, 3, 3, 3]);
    expect(state.captureFailures).toHaveLength(3);
    expect(state.captureFailures.every((f: any) => f.quarantined && f.attempts === 3)).toBe(true);
    expect(state.lastSync).toBe("2026-06-05T00:00:00Z");
  } finally { tabs.query = oldQuery; tabs.sendMessage = oldSend; }
});

test("retrying a confirmed cohort behind the cursor cannot move the saved cursor backwards", async () => {
  const tabs = chrome.tabs as any;
  const oldQuery = tabs.query, oldSend = tabs.sendMessage;
  storageData["scrobbler.status"] = { capturesPosted: 0, providers: { chatgpt: { lastSync: "2026-06-06T00:00:00Z" } } };
  tabs.query = (_query: any, done: any) => done([{ id: 1, url: "https://chatgpt.com/" }]);
  tabs.sendMessage = (_id: any, _request: any, done: any) => done({ ok: true, source: "chatgpt", captureFailures: [], maxConversationUpdatedAt: "2026-06-05T00:00:00Z" });
  globalThis.fetch = (async () => Response.json({ ok: true })) as unknown as typeof fetch;
  try {
    expect(await sendRuntimeMessage({ type: "SCROBBLER_SYNC_ACTIVE_TAB" })).toMatchObject({ ok: true });
    expect((storageData["scrobbler.status"] as any).providers.chatgpt.lastSync).toBe("2026-06-06T00:00:00Z");
  } finally { tabs.query = oldQuery; tabs.sendMessage = oldSend; }
});

test("a proxy login page returned as a successful capture acknowledgement is environmental", async () => {
  globalThis.fetch = (async () => new Response("<html>proxy sign-in</html>", { headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
  expect(await sendRuntimeMessage({ type: "SCROBBLER_CAPTURE_READY", capture: buildRawCapture({ source: "chatgpt", sourceId: "c", endpoint: "/detail", payload: {} }) }))
    .toMatchObject({ ok: false, error_type: "transient" });
});
