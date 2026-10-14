import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeAtomicFile } from "./atomic-file";
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

/** One tiny read per capture. Existing archives need only one discovery scan. */
export function latestRaw(dir: string): Latest | null {
  try {
    const latest = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8")) as Latest;
    if (/^.+-[a-f0-9]{64}\.json\.gz$/.test(latest.file) && !/[\/\\]/.test(latest.file) && existsSync(join(dir, latest.file))) {
      if (latest.hash_version === 3) return latest;
      // Upgrade only the pointed-to version, without scanning history or duplicating it.
      const capture = JSON.parse(Buffer.from(Bun.gunzipSync(readFileSync(join(dir, latest.file)))).toString()) as RawCapture;
      const upgraded = { ...latest, content_hash: rawContentHash(capture), hash_version: 3 };
      writeLatestRaw(dir, upgraded);
      return upgraded;
    }
  } catch (error) {
    if (!existsSync(dir)) return null;
    if ((error as NodeJS.ErrnoException).code && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const files = readdirSync(dir).filter(file => /^.+-[a-f0-9]{64}\.json\.gz$/.test(file));
  let newest: string | undefined, modified = -Infinity;
  for (const file of files) {
    const mtime = statSync(join(dir, file)).mtimeMs;
    if (mtime > modified || (mtime === modified && file > (newest ?? ""))) { newest = file; modified = mtime; }
  }
  if (!newest) return null;
  const capture = JSON.parse(Buffer.from(Bun.gunzipSync(readFileSync(join(dir, newest)))).toString()) as RawCapture;
  const latest = { file: newest, content_hash: rawContentHash(capture) };
  writeLatestRaw(dir, latest);
  return latest;
}
export function writeLatestRaw(dir: string, latest: Latest): void {
  writeAtomicFile(join(dir, "latest.json"), JSON.stringify({ ...latest, hash_version: 3 }));
}
