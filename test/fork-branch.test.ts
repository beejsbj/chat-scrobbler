// test/fork-branch.test.ts
// TDD: failing tests for fork/branch capture across all three providers.
// These test the new behaviour BEFORE implementation -- run them and watch them fail,
// then implement, then watch them pass.
import { test, expect } from "bun:test";
import { parseChatgpt, sessionFromChatgptConversation } from "../src/parsers/chatgpt";
import { parseClaude } from "../src/parsers/claude";
import { parseGemini } from "../src/parsers/gemini";
import { activePath } from "../src/store/sessions";
import { openIndex, indexSession, searchMessages, listSessions } from "../src/indexer/sqlite";
import type { Session } from "../src/schema/types";

// ---------------------------------------------------------------------------
// Helper: build a minimal branching ChatGPT mapping
// two children off n1: n2a (inactive branch) and n2b (active branch)
// current_node = "n3" which is a child of n2b
// ---------------------------------------------------------------------------
const chatgptBranchConv = {
  conversation_id: "conv-fork",
  title: "Fork Test",
  create_time: 1700000000.0,
  update_time: 1700000010.0,
  current_node: "n3",
  mapping: {
    root: { id: "root", message: null, parent: null, children: ["n1"] },
    n1: {
      id: "n1",
      message: { id: "n1", author: { role: "user" }, content: { content_type: "text", parts: ["initial question"] }, metadata: {} },
      parent: "root",
      children: ["n2a", "n2b"],
    },
    n2a: {
      id: "n2a",
      message: { id: "n2a", author: { role: "assistant" }, content: { content_type: "text", parts: ["answer on branch A"] }, metadata: {} },
      parent: "n1",
      children: [],
    },
    n2b: {
      id: "n2b",
      message: { id: "n2b", author: { role: "assistant" }, content: { content_type: "text", parts: ["answer on branch B"] }, metadata: {} },
      parent: "n1",
      children: ["n3"],
    },
    n3: {
      id: "n3",
      message: { id: "n3", author: { role: "user" }, content: { content_type: "text", parts: ["follow-up on B"] }, metadata: {} },
      parent: "n2b",
      children: [],
    },
  },
};

// ---------------------------------------------------------------------------
// ChatGPT: emit ALL branch nodes
// ---------------------------------------------------------------------------

test("chatgpt: emits all branch nodes including inactive branches", () => {
  const s = sessionFromChatgptConversation(chatgptBranchConv, { capture_method: "api", raw_ref: "raw/api/chatgpt:conv-fork" });
  expect(s).not.toBeNull();
  const ids = s!.messages.map((m) => m.id);
  // All four non-root emitted nodes must be present
  expect(ids).toContain("n1");
  expect(ids).toContain("n2a");
  expect(ids).toContain("n2b");
  expect(ids).toContain("n3");
});

test("chatgpt: every non-null parent_id resolves within messages[]", () => {
  const s = sessionFromChatgptConversation(chatgptBranchConv, { capture_method: "api", raw_ref: "raw/api/chatgpt:conv-fork" });
  const idSet = new Set(s!.messages.map((m) => m.id));
  for (const m of s!.messages) {
    if (m.parent_id !== null) {
      expect(idSet.has(m.parent_id)).toBe(true);
    }
  }
});

test("chatgpt: active_leaf_id is set to the emitted node nearest to current_node", () => {
  const s = sessionFromChatgptConversation(chatgptBranchConv, { capture_method: "api", raw_ref: "raw/api/chatgpt:conv-fork" });
  // current_node = "n3" which has a message and is emitted, so active_leaf_id = "n3"
  expect(s!.active_leaf_id).toBe("n3");
});

test("chatgpt: active_leaf_id null when current_node absent", () => {
  const conv = { ...chatgptBranchConv, current_node: null };
  const s = sessionFromChatgptConversation(conv, { capture_method: "api", raw_ref: "x" });
  expect(s!.active_leaf_id).toBeNull();
});

test("chatgpt: n2a has parent_id = n1 (nearest emitted ancestor)", () => {
  const s = sessionFromChatgptConversation(chatgptBranchConv, { capture_method: "api", raw_ref: "x" });
  const n2a = s!.messages.find((m) => m.id === "n2a")!;
  expect(n2a.parent_id).toBe("n1");
});

test("chatgpt: n2b has parent_id = n1 (nearest emitted ancestor)", () => {
  const s = sessionFromChatgptConversation(chatgptBranchConv, { capture_method: "api", raw_ref: "x" });
  const n2b = s!.messages.find((m) => m.id === "n2b")!;
  expect(n2b.parent_id).toBe("n1");
});

test("chatgpt: n3 has parent_id = n2b (its actual parent is emitted)", () => {
  const s = sessionFromChatgptConversation(chatgptBranchConv, { capture_method: "api", raw_ref: "x" });
  const n3 = s!.messages.find((m) => m.id === "n3")!;
  expect(n3.parent_id).toBe("n2b");
});

// ---------------------------------------------------------------------------
// Claude: emit ALL nodes (including sibling branches)
// ---------------------------------------------------------------------------

const claudeBranchCapture = {
  source: "claude", capture_method: "api", schema_version: 1,
  fetched_at: "2026-06-10T00:00:00.000Z", source_id: "cl-fork",
  endpoint: "/api/organizations/org-1/chat_conversations/cl-fork", account: "org-1",
  payload: {
    uuid: "cl-fork", name: "Fork Test",
    created_at: "2025-01-01T00:00:00Z", updated_at: "2025-01-01T00:01:00Z",
    current_leaf_message_uuid: "m2b",
    chat_messages: [
      { uuid: "m1", sender: "human", parent_message_uuid: null, created_at: "2025-01-01T00:00:01Z", content: [{ type: "text", text: "question" }] },
      { uuid: "m2a", sender: "assistant", parent_message_uuid: "m1", created_at: "2025-01-01T00:00:02Z", content: [{ type: "text", text: "branch A answer" }] },
      { uuid: "m2b", sender: "assistant", parent_message_uuid: "m1", created_at: "2025-01-01T00:00:03Z", content: [{ type: "text", text: "branch B answer" }] },
    ],
  },
};

test("claude: emits ALL sibling branch nodes (not only active leaf chain)", () => {
  const [s] = parseClaude(claudeBranchCapture);
  const ids = s.messages.map((m) => m.id);
  expect(ids).toContain("m1");
  expect(ids).toContain("m2a");
  expect(ids).toContain("m2b");
  expect(s.messages).toHaveLength(3);
});

test("claude: every non-null parent_id resolves within messages[]", () => {
  const [s] = parseClaude(claudeBranchCapture);
  const idSet = new Set(s.messages.map((m) => m.id));
  for (const m of s.messages) {
    if (m.parent_id !== null) {
      expect(idSet.has(m.parent_id)).toBe(true);
    }
  }
});

test("claude: active_leaf_id points to the selected leaf (m2b)", () => {
  const [s] = parseClaude(claudeBranchCapture);
  expect(s.active_leaf_id).toBe("m2b");
});

test("claude: active_leaf_id null when current_leaf_message_uuid absent", () => {
  const cap = {
    ...claudeBranchCapture,
    payload: { ...claudeBranchCapture.payload, current_leaf_message_uuid: undefined },
  };
  const [s] = parseClaude(cap);
  expect(s.active_leaf_id).toBeNull();
});

// ---------------------------------------------------------------------------
// Gemini: emit ALL candidates for a turn, chain turns into a tree
// ---------------------------------------------------------------------------

// Build a synthetic Gemini payload with 2 turns, turn 0 has 2 candidates
const geminiTurn0UserRef = ["c_abc", "r_user0"];
const geminiTurn0RespRef = ["c_abc", "r_resp0", "rc_candidate_b"]; // selected = rc_candidate_b
const geminiTurn0UserMeta = [["what is a fork?"], 2, null, 1, "hex0", 0, null, null, false];
const geminiTurn0RespData = [
  // candidates array: two candidates
  [
    ["rc_candidate_a", ["Fork is a branching point."]],
    ["rc_candidate_b", ["A fork diverges a path into two."]],
  ],
  null,
  null,
  "rc_candidate_b", // turn[3][3] = default candidate rc id
  null, null, null, null, "CA", null, null, null, null, null, "hex0",
  null, null, "hex0", null, null, null, "2.0 Flash",
  null, null, 1, 1,
];
const geminiTurn0Ts = [1800000000, 0];

const geminiTurn1UserRef = ["c_abc", "r_user1"];
const geminiTurn1RespRef = null; // no selected resp ref at turn[1]
const geminiTurn1UserMeta = [["what about merge?"], 2, null, 1, "hex1", 0, null, null, false];
const geminiTurn1RespData = [
  [
    ["rc_merge_a", ["Merge combines branches."]],
  ],
  null,
  null,
  "rc_merge_a",
  null, null, null, null, "CA", null, null, null, null, null, "hex1",
  null, null, "hex1", null, null, null, "2.0 Flash",
  null, null, 1, 1,
];
const geminiTurn1Ts = [1800000010, 0];

const geminiBranchCapture = {
  source: "gemini", capture_method: "api", schema_version: 1,
  fetched_at: "2026-06-10T00:00:00.000Z", source_id: "abcdef1234567890",
  endpoint: "/_/BardChatUi/data/batchexecute?rpcids=hNvQHb", account: null,
  payload: [
    [
      [geminiTurn0UserRef, geminiTurn0RespRef, geminiTurn0UserMeta, geminiTurn0RespData, geminiTurn0Ts],
      [geminiTurn1UserRef, geminiTurn1RespRef, geminiTurn1UserMeta, geminiTurn1RespData, geminiTurn1Ts],
    ],
    null, null, [],
  ],
};

test("gemini: emits BOTH candidates for turn 0 as assistant messages", () => {
  const [s] = parseGemini(geminiBranchCapture);
  const assistants = s.messages.filter((m) => m.role === "assistant");
  // turn 0 has 2 candidates + turn 1 has 1 candidate = 3 assistant messages total
  expect(assistants).toHaveLength(3);
  const ids = assistants.map((m) => m.id);
  expect(ids).toContain("rc_candidate_a");
  expect(ids).toContain("rc_candidate_b");
  expect(ids).toContain("rc_merge_a");
});

test("gemini: both turn-0 candidates have parent_id = turn-0 user message", () => {
  const [s] = parseGemini(geminiBranchCapture);
  const userMsgId = s.messages.find((m) => m.role === "user" && m.id === "r_user0")!.id;
  const candA = s.messages.find((m) => m.id === "rc_candidate_a")!;
  const candB = s.messages.find((m) => m.id === "rc_candidate_b")!;
  expect(candA.parent_id).toBe(userMsgId);
  expect(candB.parent_id).toBe(userMsgId);
});

test("gemini: turn-1 user message parent_id = selected candidate of turn 0", () => {
  const [s] = parseGemini(geminiBranchCapture);
  // turn[1][2] of turn 0 = "rc_candidate_b" which matches an emitted candidate
  const turn1User = s.messages.find((m) => m.id === "r_user1")!;
  expect(turn1User.parent_id).toBe("rc_candidate_b");
});

test("gemini: active_leaf_id = last turn's selected assistant id", () => {
  const [s] = parseGemini(geminiBranchCapture);
  // last turn selected = rc_merge_a (turn[3][3])
  expect(s.active_leaf_id).toBe("rc_merge_a");
});

test("gemini: every non-null parent_id resolves within messages[]", () => {
  const [s] = parseGemini(geminiBranchCapture);
  const idSet = new Set(s.messages.map((m) => m.id));
  for (const m of s.messages) {
    if (m.parent_id !== null) {
      expect(idSet.has(m.parent_id)).toBe(true);
    }
  }
});

// ---------------------------------------------------------------------------
// activePath function
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "test:s1", source: "chatgpt", source_id: "s1", capture_method: "api",
    title: "T", created_at: "2025-01-01T00:00:00Z", updated_at: "2025-01-01T00:00:00Z",
    default_model: null, account: null, raw_ref: "x", schema_version: 1,
    messages: [],
    ...overrides,
  };
}

test("activePath: returns all messages when active_leaf_id is absent (legacy fallback)", () => {
  const msgs = [
    { id: "m1", role: "user" as const, created_at: null, parent_id: null, model: null, blocks: [], text: "a" },
    { id: "m2", role: "assistant" as const, created_at: null, parent_id: "m1", model: null, blocks: [], text: "b" },
  ];
  const s = makeSession({ messages: msgs });
  expect(activePath(s)).toEqual(msgs);
});

test("activePath: returns all messages when active_leaf_id is null", () => {
  const msgs = [
    { id: "m1", role: "user" as const, created_at: null, parent_id: null, model: null, blocks: [], text: "a" },
    { id: "m2", role: "assistant" as const, created_at: null, parent_id: "m1", model: null, blocks: [], text: "b" },
  ];
  const s = makeSession({ messages: msgs, active_leaf_id: null });
  expect(activePath(s)).toEqual(msgs);
});

test("activePath: walks parent_id chain to root and returns active path in order", () => {
  // Tree: m1 -> m2b (active), m1 -> m2a (inactive), m2b -> m3 (active)
  const msgs = [
    { id: "m1", role: "user" as const, created_at: null, parent_id: null, model: null, blocks: [], text: "q" },
    { id: "m2a", role: "assistant" as const, created_at: null, parent_id: "m1", model: null, blocks: [], text: "inactive" },
    { id: "m2b", role: "assistant" as const, created_at: null, parent_id: "m1", model: null, blocks: [], text: "active branch" },
    { id: "m3", role: "user" as const, created_at: null, parent_id: "m2b", model: null, blocks: [], text: "follow-up" },
  ];
  const s = makeSession({ messages: msgs, active_leaf_id: "m3" });
  const path = activePath(s);
  expect(path.map((m) => m.id)).toEqual(["m1", "m2b", "m3"]);
});

test("activePath: falls back to all messages when active_leaf_id not in messages", () => {
  const msgs = [
    { id: "m1", role: "user" as const, created_at: null, parent_id: null, model: null, blocks: [], text: "a" },
  ];
  const s = makeSession({ messages: msgs, active_leaf_id: "m-nonexistent" });
  expect(activePath(s)).toEqual(msgs);
});

test("activePath: cycle-safe (no infinite loop on malformed data)", () => {
  // m1 -> m2 -> m1 (cycle via parent_id)
  const msgs = [
    { id: "m1", role: "user" as const, created_at: null, parent_id: "m2", model: null, blocks: [], text: "a" },
    { id: "m2", role: "assistant" as const, created_at: null, parent_id: "m1", model: null, blocks: [], text: "b" },
  ];
  const s = makeSession({ messages: msgs, active_leaf_id: "m2" });
  // Should not throw or hang; should return at most 2 messages
  const path = activePath(s);
  expect(path.length).toBeLessThanOrEqual(2);
});

// ---------------------------------------------------------------------------
// sessionToMarkdown uses active path
// ---------------------------------------------------------------------------

test("sessionToMarkdown: contains only active-branch text (not inactive branch text)", () => {
  const { sessionToMarkdown } = require("../src/store/sessions");
  const msgs = [
    { id: "m1", role: "user" as const, created_at: null, parent_id: null, model: null, blocks: [{ type: "text" as const, text: "question" }], text: "question" },
    { id: "m2a", role: "assistant" as const, created_at: null, parent_id: "m1", model: null, blocks: [{ type: "text" as const, text: "inactive answer" }], text: "inactive answer" },
    { id: "m2b", role: "assistant" as const, created_at: null, parent_id: "m1", model: null, blocks: [{ type: "text" as const, text: "active answer" }], text: "active answer" },
  ];
  const s = makeSession({ messages: msgs, active_leaf_id: "m2b", title: "Branched" });
  const md = sessionToMarkdown(s);
  expect(md).toContain("active answer");
  expect(md).not.toContain("inactive answer");
});

// ---------------------------------------------------------------------------
// SQLite: message_count = activePath length; FTS indexes ALL messages
// ---------------------------------------------------------------------------

test("sqlite: message_count equals active-path length (not total messages)", () => {
  const db = openIndex(":memory:");
  const msgs = [
    { id: "m1", role: "user" as const, created_at: null, parent_id: null, model: null, blocks: [], text: "question" },
    { id: "m2a", role: "assistant" as const, created_at: null, parent_id: "m1", model: null, blocks: [], text: "branch A inactive" },
    { id: "m2b", role: "assistant" as const, created_at: null, parent_id: "m1", model: null, blocks: [], text: "branch B active" },
  ];
  const s = makeSession({ messages: msgs, active_leaf_id: "m2b", title: "Test" });
  indexSession(db, s);
  const rows = listSessions(db);
  // active path = [m1, m2b] = 2 messages
  expect(rows[0].message_count).toBe(2);
  db.close();
});

test("sqlite: FTS indexes all messages including inactive branches (search finds them)", () => {
  const db = openIndex(":memory:");
  const msgs = [
    { id: "m1", role: "user" as const, created_at: null, parent_id: null, model: null, blocks: [], text: "question" },
    { id: "m2a", role: "assistant" as const, created_at: null, parent_id: "m1", model: null, blocks: [], text: "only on inactive branch xyz" },
    { id: "m2b", role: "assistant" as const, created_at: null, parent_id: "m1", model: null, blocks: [], text: "active branch text" },
  ];
  const s = makeSession({ messages: msgs, active_leaf_id: "m2b", title: "Test" });
  indexSession(db, s);
  // "xyz" exists ONLY on the inactive branch m2a -- but FTS should still find it
  const hits = searchMessages(db, "xyz");
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0].message_id).toBe("m2a");
  db.close();
});
