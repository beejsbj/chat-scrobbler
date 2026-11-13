import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

// Host paths in tracked files tie a public repo to one machine. Pieces are joined so this file does not match itself.
const HOST_PATH = new RegExp([
  "/mnt" + "/server-ssd",
  "/home" + "/(?!scrobbler\\b)[A-Za-z0-9._-]+", // /home/scrobbler is the container user's home
  "/Users" + "/[A-Za-z0-9._-]+",
].join("|"));

const BINARY = /\.(png|jpe?g|gif|ico|webp|zip|gz|woff2?|ttf|pdf|lockb)$/i;

test("tracked files carry no host paths", () => {
  const files = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root }).stdout.toString().split("\0").filter(Boolean);
  expect(files.length).toBeGreaterThan(100);
  const hits: string[] = [];
  for (const file of files) {
    if (BINARY.test(file)) continue;
    let text: string;
    try { text = readFileSync(join(root, file), "utf8"); } catch { continue; } // deleted in the working tree
    text.split("\n").forEach((line, index) => { if (HOST_PATH.test(line)) hits.push(`${file}:${index + 1}`); });
  }
  expect(hits).toEqual([]);
});
