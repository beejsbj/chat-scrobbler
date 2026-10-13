import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getParser } from "../src/parsers/registry";
import { SOURCES } from "../src/store/raw-catalog";
import { assertRawCapture } from "../packages/shared/src/raw-capture";

const dir = join(import.meta.dir, "fixtures/contract");
const files = existsSync(dir) ? readdirSync(dir).filter(file => file.endsWith(".json") && !file.endsWith(".allowlist.json")) : [];

test("sanitized raw contracts cover every provider", () => {
  const sources = files.map(file => JSON.parse(readFileSync(join(dir, file), "utf8")).source);
  for (const source of SOURCES) expect(sources).toContain(source);
});

for (const file of files) test(`raw contract: ${file}`, () => {
  const capture = JSON.parse(readFileSync(join(dir, file), "utf8"));
  assertRawCapture(capture);
  const allowlistPath = join(dir, file.replace(/\.json$/, ".allowlist.json"));
  const allowed: string[] = existsSync(allowlistPath) ? JSON.parse(readFileSync(allowlistPath, "utf8")) : [];
  expect(Array.isArray(allowed) && allowed.every(type => typeof type === "string")).toBe(true);
  const sessions = getParser(capture.source, capture.capture_method)(capture, { raw_ref: `contract/${file}` });
  expect(sessions.length).toBeGreaterThan(0);
  for (const session of sessions) {
    expect(session.source).toBe(capture.source);
    expect(session.messages.length).toBeGreaterThan(0);
    const unknown = session.messages.flatMap(message => message.blocks.filter(block => block.type === "unknown").map(block => block.provider_type));
    expect(unknown.filter(type => !allowed.includes(type))).toEqual([]);
  }
});
