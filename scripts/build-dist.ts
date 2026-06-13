// scripts/build-dist.ts
// Builds the personal distributable: dist/chat-scrobbler (single compiled binary)
// plus dist/extension/ (the unpacked browser extension to load in Chrome).
// Run with: bun run build:dist
import { rmSync, mkdirSync, cpSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");

function run(cmd: string[], label: string): void {
  const res = Bun.spawnSync(cmd, { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (res.exitCode !== 0) {
    console.error(`build-dist: ${label} failed (exit ${res.exitCode})`);
    process.exit(1);
  }
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// 1. Compile the CLI into a single self-contained binary.
run(
  [process.execPath, "build", "--compile", "src/cli/chat-scrobbler.ts", "--outfile", join(dist, "chat-scrobbler")],
  "binary compile",
);

// 2. Build the browser extension and ship it alongside the binary, where
//    `chat-scrobbler init` looks for it (sibling "extension" dir).
run([process.execPath, "run", "packages/extension/scripts/build.ts"], "extension build");
const extBuild = join(root, "packages", "extension", "build");
if (!existsSync(extBuild)) {
  console.error(`build-dist: extension build output missing at ${extBuild}`);
  process.exit(1);
}
cpSync(extBuild, join(dist, "extension"), { recursive: true });

console.log(`\nbuild-dist: done`);
console.log(`  binary:    ${join(dist, "chat-scrobbler")}`);
console.log(`  extension: ${join(dist, "extension")}`);
