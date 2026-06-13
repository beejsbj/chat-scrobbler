import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

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
console.log(`Built extension in ${buildDir}`);
