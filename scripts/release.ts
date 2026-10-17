// scripts/release.ts
// Cut a GitHub release: cross-compile the binary for the common desktop/server
// targets, zip the unpacked extension, and upload everything as release assets
// so the curl installer (install.sh) has something to download.
//
// Usage: bun run release v0.1.0 [--build-only | --publish-only]
// Requires: gh CLI authenticated, and the repo pushed to GitHub.
//
// Normally CI runs this on a pushed v* tag (.github/workflows/release.yml):
// --build-only fills dist/release, native runners smoke-test each binary, then
// --publish-only uploads the already-built assets. Tags with a pre-release
// suffix (v0.5.0-rc1) publish as GitHub pre-releases, which the installer's
// releases/latest URL ignores.

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

const [tag, mode] = process.argv.slice(2);
if (!tag || !/^v\d/.test(tag) || (mode && mode !== "--build-only" && mode !== "--publish-only")) {
  console.error("Usage: bun run release v<major.minor.patch> [--build-only | --publish-only]");
  process.exit(2);
}

const assets = [
  ...Object.keys(TARGETS).map((s) => join(outDir, `chat-scrobbler-${s}`)),
  join(outDir, "extension.zip"),
];

if (mode !== "--publish-only") build();
if (mode !== "--build-only") publish();

function build(): void {
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

  console.log(`release: built ${assets.length} assets in ${outDir}`);
}

// 3. Create the GitHub release with all assets.
function publish(): void {
  const missing = assets.filter((a) => !existsSync(a));
  if (missing.length > 0) {
    console.error(`release: missing assets, build first:\n  ${missing.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`release: creating GitHub release ${tag}`);
  run(
    ["gh", "release", "create", tag, ...assets,
      "--title", tag,
      ...(tag.includes("-") ? ["--prerelease"] : []),
      "--notes", `chat-scrobbler ${tag}. Install: curl -fsSL https://raw.githubusercontent.com/beejsbj/chat-scrobbler/main/install.sh | sh`],
    "gh release create",
  );
  console.log(`\nrelease: done. Verify the installer against the new release.`);
}
