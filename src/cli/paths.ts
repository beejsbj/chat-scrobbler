// src/cli/paths.ts
// Resolve where the unpacked browser extension lives, across the two install
// shapes: a compiled binary (extension shipped alongside it, or unpacked into
// the data home by the curl installer) and a source checkout (the build output
// under packages/extension/build).

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Return the first extension directory that exists, or null if none is found.
 * Order: sibling of the binary (build:dist layout) -> data-home (curl install)
 * -> source-checkout build output.
 */
export function resolveExtensionDir(execPath: string = process.execPath): string | null {
  const candidates = [
    join(dirname(execPath), "extension"),
    join(homedir(), ".local", "share", "chat-scrobbler", "extension"),
    join(process.cwd(), "packages", "extension", "build"),
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return null;
}
