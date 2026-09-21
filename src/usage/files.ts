import { readdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

export async function walkFiles(root: string, accept: (path: string) => boolean): Promise<string[]> {
  const files: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && accept(path)) files.push(path);
    }));
  };
  await visit(root);
  return files.sort();
}

export async function newestUniqueRollouts(roots: string[]): Promise<string[]> {
  const candidates = (await Promise.all(roots.map((root) => walkFiles(root, (path) => path.endsWith(".jsonl"))))).flat();
  const selected = new Map<string, { path: string; mtime: number }>();
  await Promise.all(candidates.map(async (path) => {
    const id = path.match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i)?.[1] ?? path;
    let mtime = 0;
    try { mtime = (await stat(path)).mtimeMs; } catch { /* ignored */ }
    const prior = selected.get(id);
    if (!prior || mtime >= prior.mtime) selected.set(id, { path, mtime });
  }));
  return [...selected.values()].map((item) => item.path).sort();
}

export async function forEachJsonLine(path: string, onValue: (value: Record<string, any>) => void): Promise<void> {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim()) {
      try { onValue(JSON.parse(line)); } catch { /* one corrupt line must not lose the file */ }
    }
  }
}
