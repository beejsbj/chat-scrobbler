const CHAT_ID = /^c_([0-9a-f]{16})$/;

/**
 * Conversation ids in a conversation-list RPC payload, in document order and without duplicates. The payload's shape
 * is not verified against live traffic, so this reads by content, not position: any string of the form
 * `c_<16 hex>` anywhere in the nested arrays and objects is a chat id. The `c_` prefix is dropped, matching the
 * `/app/<id>` form the rest of the extension uses. Iterative, so a deeply nested payload cannot overflow the stack.
 */
export function collectConversationIds(payload: unknown): string[] {
  const ids = new Set<string>();
  const pending: unknown[] = [payload];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      const id = value.match(CHAT_ID)?.[1];
      if (id) ids.add(id);
    } else if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) pending.push(value[i]);
    } else if (typeof value === "object" && value !== null) {
      const children = Object.values(value);
      for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]);
    }
  }
  return [...ids];
}
