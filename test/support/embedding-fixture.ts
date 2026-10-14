import type { Session } from "../../src/schema/types";
export function fixture(text = "archived words"): Session {
  return { id: "chatgpt:test", source: "chatgpt", source_id: "test", title: "T", capture_method: "api", created_at: "2026-01-01", updated_at: "2026-01-02", default_model: null, account: null, raw_ref: "raw", schema_version: 1,
    messages: [{ id: "m", text, blocks: [], role: "user", created_at: null, parent_id: null, model: null }] };
}
