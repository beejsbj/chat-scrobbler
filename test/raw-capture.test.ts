import { expect, test } from "bun:test";
import {
  assertRawCapture,
  buildRawCapture,
  captureStorageName,
  capturesUrl,
  deleteCaptureUrl,
  healthUrl,
  isRawCapture,
  toCaptureArray,
} from "../packages/shared/src";

test("buildRawCapture wraps provider payload without normalizing it", () => {
  const payload = { mapping: { node: { message: "verbatim" } } };
  const capture = buildRawCapture({
    source: "chatgpt",
    sourceId: "conv-1",
    endpoint: "/backend-api/conversation/conv-1",
    payload,
    fetchedAt: "2026-06-05T10:00:00.000Z",
    conversationUpdatedAt: "2026-06-05T09:00:00.000Z",
  });

  expect(capture).toMatchObject({
    source: "chatgpt",
    capture_method: "api",
    schema_version: 1,
    source_id: "conv-1",
    payload,
  });
  expect(capture.payload).toBe(payload);
  expect(isRawCapture(capture)).toBe(true);
});

test("assertRawCapture rejects malformed envelopes", () => {
  expect(() => assertRawCapture({ source: "chatgpt" })).toThrow("method");
  expect(() =>
    assertRawCapture({
      source: "chatgpt",
      capture_method: "api",
      schema_version: 1,
      fetched_at: "not-a-date",
      source_id: "x",
      endpoint: "/x",
      payload: {},
    }),
  ).toThrow("fetched_at");
});

test("toCaptureArray accepts one capture or a batch", () => {
  const one = buildRawCapture({
    source: "claude",
    sourceId: "cl-1",
    endpoint: "/api/organizations/org/chat_conversations/cl-1",
    payload: { uuid: "cl-1" },
    fetchedAt: "2026-06-05T10:00:00.000Z",
  });

  expect(toCaptureArray(one)).toEqual([one]);
  expect(toCaptureArray([one])).toEqual([one]);
});

test("captureStorageName prevents path traversal in source ids", () => {
  const capture = buildRawCapture({
    source: "claude",
    sourceId: "../../secret/chat",
    endpoint: "/x",
    payload: {},
    fetchedAt: "2026-06-05T10:00:00.000Z",
  });

  expect(captureStorageName(capture)).toBe("secret_chat-2026-06-05T10-00-00-000Z.json");
});

test("endpoint helpers normalize trailing slashes", () => {
  expect(capturesUrl("http://127.0.0.1:4319/")).toBe("http://127.0.0.1:4319/captures");
  expect(healthUrl("http://127.0.0.1:4319///")).toBe("http://127.0.0.1:4319/health");
  expect(deleteCaptureUrl("http://127.0.0.1:4319///", "chatgpt", "conv 1")).toBe(
    "http://127.0.0.1:4319/captures?source=chatgpt&source_id=conv+1",
  );
});
