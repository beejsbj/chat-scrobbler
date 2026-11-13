import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeAtomicFile } from "./atomic-file";
import { writeImmutableFile } from "./immutable-file";
import type { RawCapture } from "../../packages/shared/src";

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function rawContentHash(capture: RawCapture): string {
  return createHash("sha256").update(stableJson({ endpoint: capture.endpoint, payload: capture.payload, assets: capture.assets ?? [], asset_references: capture.asset_references ?? [] })).digest("hex");
}
interface Latest { file: string; content_hash: string; hash_version?: number; }

const VERSION = /^.+-[a-f0-9]{64}\.json\.gz$/;
const STAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{1,9}))?Z-[a-f0-9]{64}\.json\.gz$/;

/** The marker, when it names a version that exists. */
export function readRawMarker(dir: string): Latest | null {
  try {
    const latest = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8")) as Latest;
    if (VERSION.test(latest.file) && !/[\/\\]/.test(latest.file) && existsSync(join(dir, latest.file))) return latest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return null;
}

/** One tiny read per capture. Existing archives need only one discovery scan. */
export function latestRaw(dir: string): Latest | null {
  const latest = readRawMarker(dir);
  if (latest) {
    if (latest.hash_version === 3) return latest;
    // Upgrade only the pointed-to version, without scanning history or duplicating it.
    const upgraded = { ...latest, content_hash: rawContentHash(readVersion(dir, latest.file)), hash_version: 3 };
    writeLatestRaw(dir, upgraded);
    return upgraded;
  }
  if (!existsSync(dir)) return null;
  const newest = newestRawVersion(dir, readdirSync(dir).filter(file => VERSION.test(file)));
  if (!newest) return null;
  const found = { file: newest, content_hash: rawContentHash(readVersion(dir, newest)) };
  writeLatestRaw(dir, found);
  return found;
}

function readVersion(dir: string, file: string): RawCapture {
  return JSON.parse(Buffer.from(Bun.gunzipSync(readFileSync(join(dir, file)))).toString()) as RawCapture;
}

function fetchedTime(file: string): number {
  const match = STAMP.exec(file);
  if (!match) return NaN;
  const [, date, hour, minute, second, fraction = "0"] = match;
  return Date.parse(`${date}T${hour}:${minute}:${second}Z`) + Number(`0.${fraction}`) * 1000;
}

/** Newest version when no marker records arrival order. Restore rewrites mtimes, so
 *  the fetched_at in each name decides. Versions derived from one capture (asset
 *  backfill, Gemini media retention) keep its fetched_at; the most enriched is newest. */
export function newestRawVersion(dir: string, files: string[]): string | undefined {
  const mtime = (file: string) => statSync(join(dir, file)).mtimeMs;
  const byMtime = (a: string, b: string) => mtime(a) - mtime(b) || (a < b ? -1 : a > b ? 1 : 0);
  const times = files.map(fetchedTime);
  // Names that do not encode a UTC fetched_at keep the arrival-mtime order.
  if (times.some(Number.isNaN)) return files.reduce<string | undefined>((newest, file) => !newest || byMtime(file, newest) > 0 ? file : newest, undefined);
  const latest = Math.max(...times);
  const tied = files.filter((_, index) => times[index] === latest);
  if (tied.length < 2) return tied[0];
  const enrichment = new Map(tied.map(file => {
    const capture = readVersion(dir, file);
    const count = (list: unknown) => Array.isArray(list) ? list.length : 0;
    return [file, [String(capture.asset_backfilled_at ?? ""), count(capture.assets) + count(capture.asset_references)] as const];
  }));
  const compare = (a: string, b: string) => {
    const [backfilledA, assetsA] = enrichment.get(a)!, [backfilledB, assetsB] = enrichment.get(b)!;
    return (backfilledA < backfilledB ? -1 : backfilledA > backfilledB ? 1 : 0) || assetsA - assetsB || byMtime(a, b);
  };
  return tied.reduce((newest, file) => compare(file, newest) > 0 ? file : newest);
}

/** Restore a backed-up marker, unless ingest has written one meanwhile. */
export function restoreLatestRaw(dir: string, file: string): void {
  const latest = { file, content_hash: rawContentHash(readVersion(dir, file)), hash_version: 3 };
  if (existsSync(join(dir, "latest.json"))) writeLatestRaw(dir, latest);
  else writeImmutableFile(join(dir, "latest.json"), JSON.stringify(latest));
}
export function writeLatestRaw(dir: string, latest: Latest): void {
  writeAtomicFile(join(dir, "latest.json"), JSON.stringify({ ...latest, hash_version: 3 }));
}
