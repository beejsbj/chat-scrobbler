import type { CostEstimate, UsageBucket, UsagePayload, UsageSnapshot } from "./types";

interface TokenRates {
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
}

// Current standard USD list prices per 1M tokens. This is deliberately a
// small, explicit allowlist: unknown and third-party-routed models are left
// unpriced instead of being assigned a guessed equivalent.
//
// Sources checked 2026-09-23:
// https://help.openai.com/en/articles/20001415
// https://developers.openai.com/api/docs/pricing
// https://platform.claude.com/docs/en/about-claude/pricing
const RATES: Record<string, TokenRates> = {
  "gpt-6-astra": { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50 },
  "gpt-5.6-sol": { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 20 },
  "gpt-5.6-terra": { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 12 },
  "gpt-5.6-luna": { input: 0.2, cachedInput: 0.02, cacheWrite: 0.25, output: 1.2 },
  "gpt-5.5": { input: 5, cachedInput: 0.5, cacheWrite: 5, output: 30 },
  "gpt-5.4": { input: 2.5, cachedInput: 0.25, cacheWrite: 2.5, output: 15 },
  "gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, cacheWrite: 0.75, output: 4.5 },
  "claude-fable-5": { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50 },
  "claude-opus-5": { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 },
  "anthropic/claude-opus-5": { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 },
  "claude-opus-4-8": { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 },
  "claude-sonnet-5": { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 },
  "anthropic/claude-sonnet-5": { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 },
  "claude-sonnet-4-6": { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 },
  "google-antigravity/claude-sonnet-4-6": { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 },
};

export function estimateBucketCostUsd(bucket: UsageBucket): number | null {
  const rates = RATES[bucket.model];
  if (!rates || bucket.totalTokens <= 0) return null;
  const uncachedInput = Math.max(0, bucket.inputTokens - bucket.cachedInputTokens - bucket.cacheWriteTokens);
  return (
    uncachedInput * rates.input
    + bucket.cachedInputTokens * rates.cachedInput
    + bucket.cacheWriteTokens * rates.cacheWrite
    + bucket.outputTokens * rates.output
  ) / 1_000_000;
}

export function addCostEstimates(snapshot: UsageSnapshot): UsagePayload {
  let amountUsd = 0;
  let pricedTokens = 0;
  let exactTokens = 0;
  const unpricedModels = new Set<string>();
  const buckets = snapshot.buckets.map((bucket) => {
    exactTokens += bucket.totalTokens;
    const estimatedUsd = estimateBucketCostUsd(bucket);
    if (estimatedUsd === null) {
      if (bucket.totalTokens > 0) unpricedModels.add(bucket.model);
      return { ...bucket, estimatedUsd: null };
    }
    amountUsd += estimatedUsd;
    pricedTokens += bucket.totalTokens;
    return { ...bucket, estimatedUsd };
  });
  const costEstimate: CostEstimate = {
    amountUsd,
    pricedTokens,
    exactTokens,
    pricedTokenRatio: exactTokens > 0 ? pricedTokens / exactTokens : 0,
    unpricedModels: [...unpricedModels].sort(),
    pricingAsOf: "2026-09-23",
    basis: "Current standard API/list-price equivalent; not actual subscription spend",
  };
  return { ...snapshot, buckets, costEstimate };
}
