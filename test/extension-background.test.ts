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
