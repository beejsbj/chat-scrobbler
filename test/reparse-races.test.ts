import { test, expect, spyOn } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reparse } from "../src/core/reparse";
import * as registry from "../src/parsers/registry";
import * as sessions from "../src/store/sessions";
import { parseChatgpt } from "../src/parsers/chatgpt";
import { storeRawCapture } from "../src/store/raw";
import { markSessionDeleted } from "../src/store/tombstones";
import { openIndex, indexSession, indexSessionWithEmbeddings, listSessions, searchMessages } from "../src/indexer/sqlite";
import fixture from "./fixtures/chatgpt-api-sample.json";

test("reparse reports raced when ingest publishes a newer raw and canonical during parsing", async () => {
  const root = mkdtempSync(join(tmpdir(), "reparse-ingest-race-"));
  const opts = { canonicalDir: join(root, "canonical", "sessions"), indexPath: join(root, "index.db") };
  const write = sessions.writeSession;
  let newerBytes = "";
  const parser = spyOn(registry, "getParser").mockImplementation(() => (capture, context) => {
    const parsed = parseChatgpt(capture, context);
    const newer = structuredClone(fixture);
    newer.payload.mapping.n1.message.content.parts[0] = "newerneedle";
    const ref = storeRawCapture(join(root, "raw"), newer as any);
    const file = write(opts.canonicalDir, parseChatgpt(newer, { raw_ref: ref })[0]);
    newerBytes = readFileSync(file, "utf8");
    return parsed;
  });
  try {
    storeRawCapture(join(root, "raw"), fixture as any);
    const report = await reparse(opts);
    expect(report).toMatchObject({ changed: 0, failed: 0, raced: 1 });
    expect(report.items[0]).toMatchObject({ status: "raced" });
    expect(readFileSync(sessions.sessionFilePath(opts.canonicalDir, "chatgpt", "conv-1"), "utf8")).toBe(newerBytes);
  } finally { parser.mockRestore(); rmSync(root, { recursive: true, force: true }); }
}, 30000);

test("deletion after canonical write prevents reparse from reinserting FTS rows", async () => {
  const root = mkdtempSync(join(tmpdir(), "reparse-delete-race-"));
  const opts = { canonicalDir: join(root, "canonical", "sessions"), indexPath: join(root, "index.db") };
  const write = sessions.writeSession;
  const writer = spyOn(sessions, "writeSession").mockImplementation((dir, session) => {
    const file = write(dir, session);
    markSessionDeleted(dir, { source: session.source, source_id: session.source_id, deleted_at: "2026-10-13T00:00:00Z" });
    return file;
  });
  try {
    storeRawCapture(join(root, "raw"), fixture as any);
    const report = await reparse(opts);
    expect(report).toMatchObject({ changed: 0, deleted: 1, failed: 0 });
    const db = openIndex(opts.indexPath);
    try {
      expect(searchMessages(db, "ego")).toEqual([]);
      expect(listSessions(db)).toEqual([]);
    } finally { db.close(); }
  } finally { writer.mockRestore(); rmSync(root, { recursive: true, force: true }); }
}, 30000);

test("index writers skip tombstoned sessions even when called independently", async () => {
  const root = mkdtempSync(join(tmpdir(), "index-tombstone-"));
  const db = openIndex(join(root, "index.db"));
  const session = parseChatgpt(fixture)[0];
  try {
    markSessionDeleted(root, { source: session.source, source_id: session.source_id, deleted_at: "2026-10-13T00:00:00Z" });
    indexSession(db, session, { canonicalDir: root });
    expect(await indexSessionWithEmbeddings(db, session, { canonicalDir: root })).toBe("stale");
    expect(searchMessages(db, "ego")).toEqual([]);
    expect(listSessions(db)).toEqual([]);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
}, 30000);

test("ingest after the canonical write cannot let reparse index an older projection", async () => {
  const root = mkdtempSync(join(tmpdir(), "reparse-index-race-"));
  const opts = { canonicalDir: join(root, "canonical", "sessions"), indexPath: join(root, "index.db") };
  const write = sessions.writeSession;
  const writer = spyOn(sessions, "writeSession").mockImplementation((dir, session) => {
    const file = write(dir, session);
    const newer = structuredClone(fixture);
    newer.payload.mapping.n1.message.content.parts[0] = "newerneedle";
    const ref = storeRawCapture(join(root, "raw"), newer as any);
    const newerSession = parseChatgpt(newer, { raw_ref: ref })[0];
    write(dir, newerSession);
    const db = openIndex(opts.indexPath);
    try { indexSession(db, newerSession, { canonicalDir: dir }); } finally { db.close(); }
    return file;
  });
  try {
    storeRawCapture(join(root, "raw"), fixture as any);
    expect(await reparse(opts)).toMatchObject({ changed: 0, raced: 1, failed: 0 });
    const db = openIndex(opts.indexPath);
    try {
      expect(searchMessages(db, "newerneedle")).toHaveLength(1);
      expect(searchMessages(db, "What is ego")).toHaveLength(0);
    } finally { db.close(); }
  } finally { writer.mockRestore(); rmSync(root, { recursive: true, force: true }); }
}, 30000);
