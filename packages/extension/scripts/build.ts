import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { manifestVersionFromTag, stampManifestVersion } from "./manifest-version";

// `--tag vX.Y.Z` (the release build) writes that version into the built manifest; without it the
// source manifest ships as is.
const tagFlag = process.argv.indexOf("--tag");
const tag = tagFlag === -1 ? null : process.argv[tagFlag + 1] ?? "";
if (tag !== null) {
  try { manifestVersionFromTag(tag); }
  catch (error) { console.error(error instanceof Error ? error.message : error); process.exit(2); }
}

const root = new URL("..", import.meta.url).pathname;
const buildDir = join(root, "build");
const distDir = join(buildDir, "dist");

rmSync(buildDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

const result = await Bun.build({
  entrypoints: [
    join(root, "src/background.ts"),
    join(root, "src/content.ts"),
    join(root, "src/popup.ts"),
  ],
  outdir: distDir,
  target: "browser",
  format: "esm",
  sourcemap: "external",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

cpSync(join(root, "static"), buildDir, { recursive: true });
if (tag !== null) stampManifestVersion(buildDir, tag);
console.log(`Built extension in ${buildDir}`);
