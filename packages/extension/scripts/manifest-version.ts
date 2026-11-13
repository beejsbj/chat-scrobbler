import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ManifestVersion { version: string; version_name?: string; }

// vMAJOR.MINOR.PATCH with an optional -prerelease, the shape release tags have.
const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const MAX_PART = 65535;

/**
 * Chrome's `version` is 1 to 4 dot-separated integers (0 to 65535, no leading zeros), so a
 * pre-release suffix cannot go there. A pre-release maps to its release version, which never
 * sorts above the final release, and the full tag goes in `version_name`, which Chrome shows.
 */
export function manifestVersionFromTag(tag: string): ManifestVersion {
  const match = TAG.exec(tag);
  if (!match || match.slice(1, 4).some(part => Number(part) > MAX_PART)) {
    throw new Error(`release tag "${tag}" cannot be mapped to a Chrome extension version (expected vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-prerelease, each number 0 to ${MAX_PART})`);
  }
  const version = match.slice(1, 4).join(".");
  return match[4] ? { version, version_name: tag } : { version };
}

/** Rewrites the version of a built (copied) manifest; the tracked source manifest is never touched. */
export function stampManifestVersion(buildDir: string, tag: string): void {
  const path = join(buildDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  const { version, version_name } = manifestVersionFromTag(tag);
  manifest.version = version;
  if (version_name) manifest.version_name = version_name; else delete manifest.version_name;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}
