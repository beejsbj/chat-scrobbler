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
