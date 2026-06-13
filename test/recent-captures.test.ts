// test/recent-captures.test.ts
import { test, expect } from "bun:test";
import { appendRecentCapture, type RecentCapture, type CaptureKind } from "../packages/extension/src/recent-captures";

function makeCapture(id: string, capturedAt = "2026-06-07T10:00:00.000Z", kind: CaptureKind = "new"): RecentCapture {
  return { id, title: `Chat ${id}`, capturedAt, kind };
}

test("appendRecentCapture adds a new entry at the front (newest-first)", () => {
  const result = appendRecentCapture([], makeCapture("a"));
  expect(result).toHaveLength(1);
  expect(result[0]!.id).toBe("a");
});

test("appendRecentCapture prepends a second distinct entry before the first", () => {
  const first = [makeCapture("a")];
  const result = appendRecentCapture(first, makeCapture("b"));
  expect(result[0]!.id).toBe("b");
  expect(result[1]!.id).toBe("a");
});

test("appendRecentCapture re-capturing the same id moves it to top without duplicating", () => {
  const existing: RecentCapture[] = [
    makeCapture("b"),
    makeCapture("a"),
    makeCapture("c"),
  ];
  const updated = makeCapture("a", "2026-06-07T11:00:00.000Z");
  const result = appendRecentCapture(existing, updated);
  expect(result[0]!.id).toBe("a");
  expect(result[0]!.capturedAt).toBe("2026-06-07T11:00:00.000Z");
  expect(result).toHaveLength(3); // no duplicate
  const ids = result.map((r) => r.id);
  expect(ids).toEqual(["a", "b", "c"]);
});

test("appendRecentCapture enforces cap of 20 by dropping the oldest entries", () => {
  const existing: RecentCapture[] = Array.from({ length: 20 }, (_, i) =>
    makeCapture(`id${i}`)
  );
  const result = appendRecentCapture(existing, makeCapture("new"));
  expect(result).toHaveLength(20);
  expect(result[0]!.id).toBe("new");
  // the last entry (id19, the "oldest") should be dropped
  expect(result.map((r) => r.id)).not.toContain("id19");
});

test("appendRecentCapture cap can be overridden", () => {
  const existing: RecentCapture[] = Array.from({ length: 5 }, (_, i) =>
    makeCapture(`id${i}`)
  );
  const result = appendRecentCapture(existing, makeCapture("new"), 5);
  expect(result).toHaveLength(5);
  expect(result[0]!.id).toBe("new");
});

test("appendRecentCapture treats an undefined/null buffer as empty", () => {
  const result = appendRecentCapture(undefined as any, makeCapture("a"));
  expect(result).toHaveLength(1);
  expect(result[0]!.id).toBe("a");
});

test("appendRecentCapture stores kind='new' and kind='update' on the entry", () => {
  const newCapture = makeCapture("a", "2026-06-07T10:00:00.000Z", "new");
  const updateCapture = makeCapture("b", "2026-06-07T10:01:00.000Z", "update");
  const result = appendRecentCapture([newCapture], updateCapture);
  expect(result[0]!.kind).toBe("update");
  expect(result[1]!.kind).toBe("new");
});

test("appendRecentCapture re-capturing updates the kind to the new value", () => {
  const existing: RecentCapture[] = [makeCapture("a", "2026-06-07T10:00:00.000Z", "new")];
  const recapture = makeCapture("a", "2026-06-07T11:00:00.000Z", "update");
  const result = appendRecentCapture(existing, recapture);
  expect(result).toHaveLength(1);
  expect(result[0]!.kind).toBe("update");
});
