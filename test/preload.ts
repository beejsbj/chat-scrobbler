import { pacing } from "../packages/extension/src/providers/sync-pacing";

// Detail fetches are paced in production; tests must not sleep between fetches.
pacing.detailMs = 0;
