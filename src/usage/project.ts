import { basename } from "node:path";

export function projectFromPath(input: string | null | undefined): string {
  if (!input) return "Unattributed";
  let path = input;
  try {
    if (path.startsWith("file://")) path = decodeURIComponent(new URL(path).pathname);
  } catch {
    // Keep the original string. It can still match a known path shape.
  }
  const normalized = path.replaceAll("\\", "/").replace(/\/$/, "");
  const workspace = normalized.match(/\/BJsWorkspace\/(?:Projects|Labs)\/([^/]+)/);
  if (workspace?.[1]) return workspace[1];
  const worktree = normalized.match(/\/\.t3\/worktrees\/([^/]+)/);
  if (worktree?.[1]) return worktree[1];
  const oldProjects = normalized.match(/\/Projects\/([^/]+)/);
  if (oldProjects?.[1]) return oldProjects[1];
  if (/\/Documents\/Codex(?:\/|$)/.test(normalized)) return "Ad-hoc sessions";
  if (/\/(?:private\/)?tmp(?:\/|$)/.test(normalized)) return "Temporary work";
  const leaf = basename(normalized);
  if (!leaf || leaf === "burooj" || leaf === "Users") return "Home";
  return leaf;
}

export function findProjectPath(value: unknown): string | null {
  const candidates: string[] = [];
  const visit = (node: unknown, key = "", depth = 0): void => {
    if (depth > 6 || candidates.length > 80) return;
    if (typeof node === "string") {
      if (/path|uri|folder|workspace|cwd/i.test(key) && (node.startsWith("/") || node.startsWith("file://"))) candidates.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 80)) visit(item, key, depth + 1);
      return;
    }
    if (node && typeof node === "object") {
      for (const [childKey, child] of Object.entries(node as Record<string, unknown>)) visit(child, childKey, depth + 1);
    }
  };
  visit(value);
  return candidates[0] ?? null;
}

