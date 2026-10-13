import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { assetsDirForCanonicalDir } from "./assets";
import { listSessionFiles } from "./sessions";

export function filesUnder(dir: string, pattern = "**/*"): string[] {
  return existsSync(dir) ? [...new Bun.Glob(pattern).scanSync({ cwd: dir, absolute: true, onlyFiles: true })] : [];
}
export function collectAssetHashes(value: unknown, hashes: Set<string>): void {
  if (typeof value === "string") {
    // Covers sha256 fields as well as legacy local_path values.
    for (const match of value.matchAll(/(?:^|\/)([a-f0-9]{64})(?:\.[a-z0-9]+)?$/g)) hashes.add(match[1]);
  } else if (Array.isArray(value)) value.forEach(item => collectAssetHashes(item, hashes));
  else if (value && typeof value === "object") Object.values(value).forEach(item => collectAssetHashes(item, hashes));
}
export function captureHashes(file: string, hashes: Set<string>): void {
  const bytes = readFileSync(file);
  collectAssetHashes(JSON.parse(file.endsWith(".gz") ? Buffer.from(Bun.gunzipSync(bytes)).toString("utf8") : bytes.toString("utf8")), hashes);
}
/** Deletion is uncommon; scan historical references rather than infer ownership from first_seen. */
export function survivingAssetHashes(canonicalDir: string, rawDir: string): Set<string> | null {
  const hashes = new Set<string>();
  try {
    for (const file of listSessionFiles(canonicalDir)) captureHashes(file, hashes);
    for (const file of filesUnder(rawDir, "**/*.json.gz")) captureHashes(file, hashes);
    for (const file of filesUnder(assetsDirForCanonicalDir(canonicalDir))) {
      if (!file.includes("/sha256/")) collectAssetHashes(basename(file), hashes);
    }
    return hashes;
  } catch {
    // An unreadable survivor may own a candidate; retain uncertain blobs.
    console.error(JSON.stringify({ event: "asset_cleanup_deferred", reason: "unreadable_surviving_reference" }));
    return null;
  }
}
