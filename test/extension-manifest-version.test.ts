import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manifestVersionFromTag, stampManifestVersion } from "../packages/extension/scripts/manifest-version";

const extensionRoot = join(import.meta.dir, "..", "packages", "extension");
const sourceManifest = join(extensionRoot, "static", "manifest.json");

test("a release tag maps to the same Chrome version", () => {
  expect(manifestVersionFromTag("v0.4.6")).toEqual({ version: "0.4.6" });
  expect(manifestVersionFromTag("v10.0.65535")).toEqual({ version: "10.0.65535" });
});

test("a pre-release tag maps to its release version and keeps the full tag as version_name", () => {
  expect(manifestVersionFromTag("v0.5.0-rc1")).toEqual({ version: "0.5.0", version_name: "v0.5.0-rc1" });
  expect(manifestVersionFromTag("v1.0.0-beta.2")).toEqual({ version: "1.0.0", version_name: "v1.0.0-beta.2" });
});

test("a tag that cannot be mapped to a Chrome version is rejected", () => {
  for (const tag of ["", "0.4.6", "v1", "v1.2", "v1.2.3.4", "v1.2.3-", "v1.2.3-rc 1", "v1.2.3+build", "v1.2.3-rc1+build", "v01.2.3", "v1.2.65536", "v-1.2.3", "vx.y.z"]) {
    expect(() => manifestVersionFromTag(tag), tag).toThrow(/cannot be mapped/);
  }
});

test("stamping rewrites only the version fields of the copied manifest", () => {
  const dir = mkdtempSync(join(tmpdir(), "manifest-stamp-"));
  try {
    const before = readFileSync(sourceManifest, "utf8");
    cpSync(sourceManifest, join(dir, "manifest.json"));
    stampManifestVersion(dir, "v0.9.1-rc2");
    const stamped = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(stamped).toMatchObject({ version: "0.9.1", version_name: "v0.9.1-rc2" });
    expect({ ...stamped, version: undefined, version_name: undefined }).toEqual({ ...JSON.parse(before), version: undefined, version_name: undefined });
    expect(readFileSync(sourceManifest, "utf8")).toBe(before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the extension build writes the tag's version into the built manifest only", () => {
  const before = readFileSync(sourceManifest, "utf8");
  const build = (...args: string[]) => {
    const res = Bun.spawnSync([process.execPath, "run", join(extensionRoot, "scripts", "build.ts"), ...args], { stdout: "pipe", stderr: "pipe" });
    expect(res.exitCode, res.stderr.toString()).toBe(0);
    return JSON.parse(readFileSync(join(extensionRoot, "build", "manifest.json"), "utf8"));
  };
  expect(build("--tag", "v7.8.9-rc3")).toMatchObject({ version: "7.8.9", version_name: "v7.8.9-rc3" });
  // Without a tag (bun run build:dist) the source manifest is shipped as it is.
  const untagged = build();
  expect(untagged.version).toBe(JSON.parse(before).version);
  expect(untagged.version_name).toBeUndefined();
  expect(readFileSync(sourceManifest, "utf8")).toBe(before);
});

test("the extension build refuses a tag it cannot map", () => {
  const res = Bun.spawnSync([process.execPath, "run", join(extensionRoot, "scripts", "build.ts"), "--tag", "v1.2"], { stdout: "pipe", stderr: "pipe" });
  expect(res.exitCode).not.toBe(0);
  expect(res.stderr.toString()).toContain("cannot be mapped");
});
