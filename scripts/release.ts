// scripts/release.ts
// Cut a GitHub release: cross-compile the binary for the common desktop/server
// targets, zip the unpacked extension, and upload everything as release assets
// so the curl installer (install.sh) has something to download.
//
// Usage: bun run release v0.1.0
// Requires: gh CLI authenticated, and the repo pushed to GitHub.

import { rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const outDir = join(root, "dist", "release");

// asset suffix -> bun --compile target
const TARGETS: Record<string, string> = {
  "darwin-arm64": "bun-darwin-arm64",
  "darwin-x64": "bun-darwin-x64",
  "linux-x64": "bun-linux-x64",
  "linux-arm64": "bun-linux-arm64",
};

function run(cmd: string[], label: string): void {
  const res = Bun.spawnSync(cmd, { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (res.exitCode !== 0) {
    console.error(`release: ${label} failed (exit ${res.exitCode})`);
    process.exit(1);
  }
}

const tag = process.argv[2];
if (!tag || !/^v\d/.test(tag)) {
  console.error("Usage: bun run release v<major.minor.patch>   (e.g. bun run release v0.1.0)");
  process.exit(2);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// 1. Cross-compile one binary per target.
for (const [suffix, target] of Object.entries(TARGETS)) {
  const outfile = join(outDir, `chat-scrobbler-${suffix}`);
  console.log(`release: compiling ${suffix} (${target})`);
  run(
    [process.execPath, "build", "--compile", `--target=${target}`,
      "src/cli/chat-scrobbler.ts", "--outfile", outfile],
    `compile ${suffix}`,
  );
}

// 2. Build the extension and zip it as a release asset.
run([process.execPath, "run", "packages/extension/scripts/build.ts"], "extension build");
const extBuild = join(root, "packages", "extension", "build");
if (!existsSync(extBuild)) {
  console.error(`release: extension build output missing at ${extBuild}`);
  process.exit(1);
}
// zip from inside the build dir so the archive has flat paths
const zipRes = Bun.spawnSync(["zip", "-r", "-q", join(outDir, "extension.zip"), "."], {
  cwd: extBuild, stdout: "inherit", stderr: "inherit",
});
if (zipRes.exitCode !== 0) {
  console.error("release: zip extension failed");
  process.exit(1);
}

// 3. Create the GitHub release with all assets.
const assets = [
  ...Object.keys(TARGETS).map((s) => join(outDir, `chat-scrobbler-${s}`)),
  join(outDir, "extension.zip"),
];
console.log(`release: creating GitHub release ${tag}`);
run(
  ["gh", "release", "create", tag, ...assets,
    "--title", tag,
    "--notes", `chat-scrobbler ${tag}. Install: curl -fsSL https://raw.githubusercontent.com/beejsbj/chat-scrobbler/main/install.sh | sh`],
  "gh release create",
);

console.log(`\nrelease: done. Verify the installer against the new release.`);
console.log(`NOTE: only the darwin-arm64 binary was runnable on this machine; the`);
console.log(`cross-compiled linux/x64 binaries are produced by bun but untested here.`);
