# BJS-546: drift and freshness observability

## Built

- `GET /status/report`: requires a configured ingest bearer token, coalesces
  concurrent requests, caches for 60 seconds, returns HTTP 200 with `ok` and
  `failures`. Unauthorized requests get 401, including when no token is configured.
- Offline `monitor`: reads raw, canonical and SQLite directly, checks provider
  freshness, new unknown types, vector coverage, upload and attachment failures,
  orphan parse failures, store write health and index readability. It does not
  require a running ingest server. A missing index is reported without replacement.
- A separate transactional SQLite state database retains asset and embedding
  failure totals, capture receipt times and unknown acknowledgements across
  restarts. Default container path: `/data/index/sessions.db.monitor.sqlite`.
- Three sanitized raw contracts derived from existing test samples. All currently
  parse with zero unknown blocks. Drop additional envelopes into
  `test/fixtures/contract/`; optional `<name>.allowlist.json` lists exact allowed
  provider types. See that directory's README.
- Architecture operations section with container and Compose commands.

Embedding storage and `src/indexer/sqlite.ts` were left unchanged. The only edits
in `src/indexer/embedding*` bind configured providers to persistent failure
counters and read/update those counters. BJS-548 should preserve that binding.

## Exact monitor command

Inside the container, with its existing config and environment:

```sh
/usr/local/bin/chat-scrobbler monitor
```

Host invocation for the repository's Compose service:

```sh
docker compose -f docker-compose.bjslab.yml exec -T scrobbler /usr/local/bin/chat-scrobbler monitor
```

No shell tools or Bun runtime are needed inside the container. The CLI exits 0
for healthy and failing checks, with empty stdout/stderr when healthy. Failure
lines are sorted and omit timestamps, tokens, URLs, titles and chat content.
Example problem output, showing independent checks:

```text
FAILED assets missing_recent_blocks=2
FAILED assets recent_upload_failures=1
FAILED embeddings recent_with_vectors=10 recent_without_vectors=90 threshold=0.95
FAILED freshness.claude stale threshold_days=7
FAILED parse failed_versions_without_canonical=1
FAILED semantic unavailable
FAILED unknown.chatgpt type_id=6f37d151e084cf28 count=2
```

The example type ID is illustrative. IDs hash provider/type pairs; raw type names
are omitted because provider strings can contain secrets or arbitrary content.
Cockpit wrapper and Hermes delivery are intentionally supplied by the orchestrator.

## Thresholds and config

JSON keys and environment overrides:

| Key | Environment variable | Default |
|-----|----------------------|---------|
| `monitorStaleDays.chatgpt` | `CHAT_SCROBBLER_MONITOR_STALE_DAYS_CHATGPT` | 7 |
| `monitorStaleDays.claude` | `CHAT_SCROBBLER_MONITOR_STALE_DAYS_CLAUDE` | 7 |
| `monitorStaleDays.gemini` | `CHAT_SCROBBLER_MONITOR_STALE_DAYS_GEMINI` | 7 |
| `monitorCoverageThreshold` | `CHAT_SCROBBLER_MONITOR_COVERAGE_THRESHOLD` | 0.95 |
| `monitorRecentHours` | `CHAT_SCROBBLER_MONITOR_RECENT_HOURS` | 48 |
| `monitorStatePath` | `CHAT_SCROBBLER_MONITOR_STATE_PATH` | `<indexPath>.monitor.sqlite` |

Set a provider's staleness to JSON `null` or env `off` to disable that provider's
freshness check. Other providers retain defaults. Numeric staleness values must
be finite and nonnegative; coverage must be between 0 and 1; recent hours must
be positive. Invalid values fall back to defaults.

Freshness uses receipt times for live captures, including duplicate polls, plus
archived capture timestamps. Conversation dates cannot establish capture health.
Coverage includes all nonempty indexed messages and uses message timestamps for
the recent denominator. Missing timestamps are counted only in total coverage.
Vectors must match current indexed text/title, active provider/model and dimension.
The semantic leg alerts if disabled, unreachable, or lacking any usable vectors
for a nonempty index, even when there are no recent messages.

Upload alerts use the recent window; totals persist forever. Hourly buckets can
extend the window by up to one hour. Recent attachment checks also use canonical
file write times to catch failed assets on newly synced old conversations.
Orphan raw parse checks examine every version without a canonical session and
ignore tombstones. They work on historical raw without process logs.

## Ack flow

1. Inspect current unknown types locally: `chat-scrobbler unknown-types`.
2. Run `/usr/local/bin/chat-scrobbler monitor --ack` inside the container.
3. Subsequent monitor invocations suppress those provider/type pairs, including
   additional occurrences. Newly seen types alert. Other failures remain visible.

The report shows acknowledgement flags. HTTP reports can retain the old result
for up to 60 seconds; the CLI always computes a new report.

## Verification

- `bun test`: 425 passed, 0 failed across 45 files (1419 assertions).
- `bun x tsc --noEmit`: passed.
- Contract fixture check after final identifier sanitization: 4 passed, 0 failed.

Tests cover token gating, quiet offline success, persistent ack and new types,
secret omission, counters after fresh processes/provider instances, receipt
freshness, per-provider overrides, stale text and old models, semantic availability
with no recent messages, missing assets, orphan failures and tombstones, broken
stores/indexes, custom state paths, invalid arguments and concurrent cache expiry.

## Practical limits

Each monitor invocation performs a real bounded embedding diagnostic and scans
local archives. A paid provider charges for that diagnostic. Monitoring does not
repair projections or assets. Initial empty raw history alerts until browser sync
or a provider override. Current backup/restore does not include monitoring state;
retain its database separately when replacing the index directory.

No production data was read, no deployment was performed, and no branch was pushed.

## Review fixes

- Fetched `origin` and rebased onto current `origin/main` (already current).
- Receipt and failure telemetry is best effort: corrupt, unwritable or locked
  state cannot abort ingest or status responses. SQLite telemetry writers never
  wait for a lock. A separate failure marker produces `FAILED state write_failed`
  in offline monitoring; successful telemetry clears it.
- Freshness is skipped when state cannot be read, avoiding misleading
  `no_captures` alerts.
- Exec must run as the container user, never `-u root`. Creation rejects a UID
  different from the data directory owner and rejects foreign-owned state files
  and SQLite sidecars.
