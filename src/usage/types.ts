export type UsageSource =
  | "codex"
  | "claude-code"
  | "cursor"
  | "github-copilot"
  | "gemini-cli"
  | "antigravity"
  | "chatgpt"
  | "claude-web"
  | "gemini-web";

export type CoverageStatus = "exact" | "partial" | "count-only" | "missing";

export interface UsageBucket {
  date: string;
  source: UsageSource;
  surface: string;
  device: string;
  project: string;
  model: string;
  sessions: number;
  messages: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface CoverageItem {
  source: UsageSource;
  status: CoverageStatus;
  detail: string;
  records: number;
}

export interface UsageSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  devices: string[];
  buckets: UsageBucket[];
  coverage: CoverageItem[];
}

export interface CollectResult {
  buckets: UsageBucket[];
  coverage: CoverageItem[];
}

export type UsageIncrement = Partial<
  Pick<UsageBucket, "sessions" | "messages" | "inputTokens" | "cachedInputTokens" | "cacheWriteTokens" | "outputTokens" | "reasoningTokens" | "totalTokens">
> & Pick<UsageBucket, "date" | "source" | "surface" | "device" | "project" | "model">;

