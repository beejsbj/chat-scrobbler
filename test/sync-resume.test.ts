import { expect, test } from "bun:test";
import { createChatgptAdapter } from "../packages/extension/src/providers/chatgpt";
import { createClaudeAdapter } from "../packages/extension/src/providers/claude";

const IDS = ["a", "b", "c", "d", "e"];
const updated = (id: string) => `2026-06-05T1${IDS.indexOf(id)}:00:00.000Z`;

/** A provider whose detail endpoint throttles one id until `throttled` is cleared. */
function provider(source: "chatgpt" | "claude", state: { throttled: string | null; retryAfter?: string; details: string[] }) {
  const fetcher = async (input: string) => {
    if (input === "/api/auth/session") return Response.json({});
    if (input === "/api/organizations") return Response.json([{ uuid: "org" }]);
    if (input.includes("conversations?") || input.includes("chat_conversations?")) {
      const items = IDS.map(id => ({ id, uuid: id, update_time: updated(id), updated_at: updated(id) }));
      return Response.json(source === "chatgpt" ? { items } : items);
    }
    const id = input.split("?")[0].split("/").pop()!;
    state.details.push(id);
    if (id === state.throttled) return new Response("", { status: 429, headers: state.retryAfter ? { "retry-after": state.retryAfter } : {} });
    return Response.json({ mapping: {}, chat_messages: [] });
  };
  return (source === "chatgpt" ? createChatgptAdapter : createClaudeAdapter)(fetcher);
}

/** Stand-in for the receiver: a chat is synced once its capture was acknowledged. */
function receiver() {
  const held = new Map<string, string>();
  return {
    emitCapture: async (capture: any) => { held.set(capture.source_id, capture.conversation_updated_at); return true; },
    getStatuses: async (items: Array<{ id: string; updatedAt: string | null }>) =>
      Object.fromEntries(items.map(item => [item.id, held.get(item.id) === item.updatedAt ? "synced" : held.has(item.id) ? "stale" : "missing"])),
    held,
  };
}

for (const source of ["chatgpt", "claude"] as const) {
  test(`${source}: a pass cut short by a 429 resumes where it stopped`, async () => {
    const state = { throttled: "c" as string | null, details: [] as string[] };
    const adapter = provider(source, state);
    const remote = receiver();
    const options = { lastSync: null, emitCapture: remote.emitCapture, getStatuses: remote.getStatuses, pace: async () => {}, sleep: async () => {} };

    await expect(adapter.sync(options)).rejects.toMatchObject({ name: "RateLimitError" });
    expect(state.details).toEqual(["a", "b", "c"]);

    state.throttled = null;
    state.details.length = 0;
    const result = await adapter.sync(options);
    // a and b are already on the receiver at the same update time: no detail fetch.
    expect(state.details).toEqual(["c", "d", "e"]);
    expect(result).toMatchObject({ scanned: 5, captured: 3, skipped: 2 });
    // the completed pass finally yields a cursor, including chats skipped as synced
    expect(result.maxConversationUpdatedAt).toBe(updated("e"));
  });

  test(`${source}: a stale chat is still fetched`, async () => {
    const state = { throttled: null, details: [] as string[] };
    const adapter = provider(source, state);
    const remote = receiver();
    remote.held.set("a", "2026-01-01T00:00:00.000Z"); // older than the listing: stale
    remote.held.set("b", updated("b"));
    await adapter.sync({ lastSync: null, emitCapture: remote.emitCapture, getStatuses: remote.getStatuses, pace: async () => {}, sleep: async () => {} });
    expect(state.details).toEqual(["a", "c", "d", "e"]);
  });

  test(`${source}: falls back to fetching when the receiver status is unavailable`, async () => {
    const state = { throttled: null, details: [] as string[] };
    const adapter = provider(source, state);
    await adapter.sync({ lastSync: null, emitCapture: async () => true, getStatuses: async () => { throw new Error("down"); }, pace: async () => {}, sleep: async () => {} });
    expect(state.details).toEqual(IDS);
  });

  test(`${source}: paces detail fetches and waits out a short Retry-After once`, async () => {
    const state = { throttled: "b" as string | null, retryAfter: "2", details: [] as string[] };
    const adapter = provider(source, state);
    let paced = 0;
    const slept: number[] = [];
    const sleep = async (ms: number) => { slept.push(ms); state.throttled = null; };
    const result = await adapter.sync({ lastSync: null, emitCapture: async () => true, pace: async () => { paced++; }, sleep });
    expect(slept).toEqual([2000]);
    expect(state.details).toEqual(["a", "b", "b", "c", "d", "e"]);
    expect(paced).toBe(4); // between detail fetches, not before the first
    expect(result.captured).toBe(5);
  });

  test(`${source}: a second 429 after waiting aborts the pass`, async () => {
    const state = { throttled: "b" as string | null, retryAfter: "2", details: [] as string[] };
    const adapter = provider(source, state);
    await expect(adapter.sync({ lastSync: null, emitCapture: async () => true, pace: async () => {}, sleep: async () => {} }))
      .rejects.toMatchObject({ name: "RateLimitError", retryAfterMs: 2000 });
    expect(state.details).toEqual(["a", "b", "b"]);
  });
}
