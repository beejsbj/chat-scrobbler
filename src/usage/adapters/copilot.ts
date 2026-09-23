import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { UsageAccumulator, isoDay } from "../aggregate";
import { filesModifiedSince, walkFiles } from "../files";
import { projectFromPath } from "../project";
import type { CollectResult } from "../types";

export interface CopilotCollectOptions { workspaceStorageRoot: string; globalStorageRoot?: string; device: string; modifiedSinceMs?: number }

async function readJson(path: string): Promise<Record<string, any> | null> {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
}

export async function collectCopilotUsage(options: CopilotCollectOptions): Promise<CollectResult> {
  const acc = new UsageAccumulator();
  let files = await walkFiles(options.workspaceStorageRoot, (path) => /\/chatSessions\/[^/]+\.json$/.test(path));
  if (options.globalStorageRoot) files.push(...await walkFiles(join(options.globalStorageRoot, "emptyWindowChatSessions"), (path) => path.endsWith(".json")));
  files = await filesModifiedSince(files, options.modifiedSinceMs);
  let records = 0;
  for (const file of files) {
    const session = await readJson(file);
    if (!session) continue;
    const workspaceRoot = file.includes("/workspaceStorage/") ? dirname(dirname(file)) : null;
    const workspace = workspaceRoot ? await readJson(join(workspaceRoot, "workspace.json")) : null;
    const workspacePath = workspace?.folder ?? workspace?.workspace ?? null;
    const requests = Array.isArray(session.requests) ? session.requests : [];
    const models = requests.map((request: any) => request?.modelId).filter((value: unknown): value is string => typeof value === "string");
    acc.add({
      date: isoDay(session.creationDate ?? session.lastMessageDate), source: "github-copilot", surface: "VS Code", device: options.device,
      project: projectFromPath(workspacePath), model: models.at(-1) ?? "Unavailable", sessions: 1, messages: requests.length,
    });
    records += 1;
  }
  return {
    buckets: acc.list(),
    coverage: [{ source: "github-copilot", status: "count-only", detail: "VS Code chat sessions and requests; token and completion counters were not retained", records }],
  };
}
