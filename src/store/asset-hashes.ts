import { existsSync, readFileSync } from "node:fs";

export function filesUnder(dir: string, pattern = "**/*"): string[] {
  return existsSync(dir) ? [...new Bun.Glob(pattern).scanSync({ cwd: dir, absolute: true, onlyFiles: true })] : [];
}
export function collectAssetHashes(value: unknown, hashes: Set<string>): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(/(?:^|\/)([a-f0-9]{64})(?:\.[a-z0-9]+)?$/g)) hashes.add(match[1]);
  } else if (Array.isArray(value)) value.forEach(item => collectAssetHashes(item, hashes));
  else if (value && typeof value === "object") Object.values(value).forEach(item => collectAssetHashes(item, hashes));
}
export function readArchiveJson(file: string): any {
  const bytes = readFileSync(file);
  return JSON.parse(file.endsWith(".gz") ? Buffer.from(Bun.gunzipSync(bytes)).toString("utf8") : bytes.toString("utf8"));
}
export function captureHashes(file: string, hashes: Set<string>): void { collectAssetHashes(readArchiveJson(file), hashes); }
export function assetHashes(value: unknown): Set<string> {
  const hashes = new Set<string>(); collectAssetHashes(value, hashes); return hashes;
}
