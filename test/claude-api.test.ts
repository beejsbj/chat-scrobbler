// test/claude-api.test.ts
import { test, expect } from "bun:test";
import { parseClaude } from "../src/parsers/claude";
import { activePath } from "../src/store/sessions";
import sample from "./fixtures/claude-api-sample.json";

test("parses a claude API capture (RawCapture envelope) into a canonical session", () => {
  const [s] = parseClaude(sample);
  expect(s.id).toBe("claude:cl-1");
  expect(s.source).toBe("claude");
  expect(s.capture_method).toBe("api");
  expect(s.title).toBe("Healing");
  // account comes from the envelope (the org), default model from conv.model
  expect(s.account).toBe("org-1");
  expect(s.default_model).toBe("claude-3-5-sonnet");
  expect(s.messages).toHaveLength(2);
  expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  expect(s.messages[1].blocks[0]).toMatchObject({ type: "reasoning", text: "Consider definitions." });
  expect(s.messages[1].blocks[1]).toMatchObject({ type: "text", text: "Healing is restoration of wholeness." });
  expect(s.messages[1].blocks[2]).toMatchObject({ type: "artifact", title: "Healing Note" });
});

test("selects the active branch via active_leaf_id + activePath (full tree retained)", () => {
  // Updated contract: parseClaude emits ALL messages (full tree) and sets active_leaf_id.
  // activePath() returns only the selected branch for rendering/display.
  const payload = {
    uuid: "cl-branch", name: "Branch",
    created_at: "2025-01-01T00:00:00Z", updated_at: "2025-01-01T00:01:00Z",
    current_leaf_message_uuid: "m2b",
    chat_messages: [
      { uuid: "m1", sender: "human", parent_message_uuid: "00000000-0000-4000-8000-000000000000", created_at: "2025-01-01T00:00:01Z", content: [{ type: "text", text: "q" }] },
      { uuid: "m2a", sender: "assistant", parent_message_uuid: "m1", created_at: "2025-01-01T00:00:02Z", content: [{ type: "text", text: "answer A" }] },
      { uuid: "m2b", sender: "assistant", parent_message_uuid: "m1", created_at: "2025-01-01T00:00:03Z", content: [{ type: "text", text: "answer B" }] },
    ],
  };
  const capture = {
    source: "claude", capture_method: "api", schema_version: 1,
    fetched_at: "2026-06-05T10:00:00.000Z", source_id: "cl-branch",
    endpoint: "/api/organizations/org-1/chat_conversations/cl-branch", account: "org-1", payload,
  };
  const [s] = parseClaude(capture);
  // Full tree: all three messages are present
  expect(s.messages.map((m) => m.id)).toEqual(["m1", "m2a", "m2b"]);
  // active_leaf_id points to the selected branch tip
  expect(s.active_leaf_id).toBe("m2b");
  // activePath returns only the active branch: m1 -> m2b
  const path = activePath(s);
  expect(path.map((m) => m.id)).toEqual(["m1", "m2b"]);
  expect(path[1].text).toBe("answer B");
});

test("hydrates Claude files and legacy attachments from uploaded asset sidecar", () => {
  const payload = {
    uuid: "cl-assets",
    name: "Assets",
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:01:00Z",
    chat_messages: [
      {
        uuid: "m1",
        sender: "human",
        content: [{ type: "text", text: "see attached" }],
        files: [{ file_uuid: "file-1", file_name: "one.pdf" }],
        attachments: [{ id: "legacy-1", filename: "legacy.txt" }],
      },
    ],
  };
  const [s] = parseClaude({
    source: "claude", capture_method: "api", schema_version: 1,
    fetched_at: "2026-06-05T10:00:00.000Z", source_id: "cl-assets",
    endpoint: "/api/organizations/org-1/chat_conversations/cl-assets", account: "org-1", payload,
    assets: [
      { pointer: "file-1", local_path: "assets/claude/cl-assets/file.pdf" },
      { pointer: "legacy-1", local_path: "assets/claude/cl-assets/legacy.txt" },
    ],
  });

  expect(s.messages[0].blocks).toContainEqual(expect.objectContaining({
    type: "attachment",
    filename: "one.pdf",
    pointer: "file-1",
    local_path: "assets/claude/cl-assets/file.pdf",
  }));
  expect(s.messages[0].blocks).toContainEqual(expect.objectContaining({
    type: "attachment",
    filename: "legacy.txt",
    pointer: "legacy-1",
    local_path: "assets/claude/cl-assets/legacy.txt",
  }));
});

test("returns [] for empty or malformed input", () => {
  expect(parseClaude(null)).toEqual([]);
  expect(parseClaude({})).toEqual([]);
  expect(parseClaude({ payload: {} })).toEqual([]);
});
