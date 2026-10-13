# BJS-543: lossless foundation handoff

Implemented on `feat/bjs-543-lossless-foundation`, based on `65ca7d0`.
Changes are committed locally. Nothing was pushed or deployed. No runtime
dependencies or embedding model/config changes were introduced.

## What was built

- Raw capture storage in `src/store/raw.ts`. Every accepted capture is stored
  before parser execution or index opening. The complete batch is archived first,
  so an early parser failure does not discard later captures. A raw write failure
  returns a logged, retriable 503 before deriving canonical data.
- Gzip versions preserve incoming JSON bytes, including individual batch entries,
  unknown envelope fields, and unknown provider content. Exact-byte retries
  deduplicate by SHA-256. Publication uses a flushed temporary file and an atomic
  hard link, preventing readers from seeing partially written versions.
- `listRawCaptures(rawDir, source, sourceId)` returns relative references;
  `readRawCapture(rawDir, ref)` reads a capture. New canonical `raw_ref` values are
  relative to the raw store. Existing placeholder references remain unchanged.
- Shared SHA-256 asset blobs plus immutable metadata. Metadata includes MIME,
  size, original pointer/URL, and the first session/message seen. New attachment
  blocks carry optional `sha256`, alongside existing `pointer` and `local_path`.
- Existing `/assets` request/response fields remain compatible. Optional
  `message_id` and `original_url` query parameters add provenance. The updated
  extension sends them. Older uploads can have null message/URL provenance.
- Extension asset download, size, and upload failures are logged and forwarded
  through the background worker to authenticated `/status` as `asset_failures`.
  Text capture continues. Reporting failures also produce a log. Failure logs
  omit URLs and provider error bodies; original URLs are retained on disk.
- Embedding failures retain previous vectors while updating canonical and literal
  search data. Complete successful vector replacements use short transactions.
  Failed calls and invalid vectors produce categorical logs and failure counts.
  Preserved vectors with changed/deleted message text are excluded from search.
- `searchMessagesReport` returns `{ hits, semantic, reason?, embedding_failures }`.
  Existing array search APIs remain available. MCP retains its legacy JSON array
  in `content[0].text` and adds the report in `structuredContent`, including when
  there are no hits. Failed-query hits also contain semantic status fields.
- Every `openIndex` writer enables WAL and a 5000 ms busy timeout. Embedding calls
  run outside write transactions. `unify` refreshes in place, preserving vectors
  on failure and captures arriving during the refresh, instead of unlinking a
  live database. Unreadable/missing canonical stores suppress session pruning.
- `/health` actually writes to the index, raw, asset, and canonical stores and
  probes the configured embedding model. It returns 503 with `status: degraded`
  on failure, or explicitly reports `semantic: disabled`. An unconfigured handler
  refuses captures instead of acknowledging unstored data.
- Backups include raw versions as well as existing sessions, assets, metadata,
  and config. Raw restore is append-only even with `force: true`. Optional raw
  counts/bytes were added to manifests; older snapshots still restore normally.

## Storage layout

Default data root: `~/.local/share/chat-scrobbler`.
Container data root with the existing Dockerfile: `/data`.

```text
<data>/
  raw/<source>/<encoded-source-id>/<fetched-at>-<sha256>.json.gz
  canonical/
    sessions/<source>/<source_id>.json
    assets/
      sha256/<first-two-hash-characters>/<sha256>       # shared blob
      sha256/<first-two-hash-characters>/<sha256>.json  # provenance metadata
      <source>/<sanitized-source-id>/<sha256>.<ext>    # compatibility hard link
  index/sessions.db                 # derived index
  index/sessions.db-wal             # SQLite-managed sidecar
  index/sessions.db-shm             # SQLite-managed sidecar
```

For `<data>/canonical/sessions`, raw defaults to `<data>/raw`. Other
`canonicalDir` layouts use a sibling `raw` directory. `IngestServerOptions` and
backup/restore options also accept an explicit `rawDir` programmatically.
Raw IDs are encoded, preserving distinctions such as `a/b` versus `a_b`.

## Decisions and trade-offs

- Hashing the entire raw capture preserves all capture metadata. A changed
  `fetched_at`, envelope field, or JSON formatting creates another version even
  if the provider payload is unchanged. This spends disk space to keep the
  incoming capture verbatim. Gzip reduces that cost.
- Session asset paths remain hard-link aliases for extension and canonical
  compatibility. Blobs and aliases must live on the same filesystem. Backup
  targets copy aliases and blobs, so snapshots can duplicate those bytes; restored
  aliases can also be separate copies. Shared blob identity remains hash-based.
- Local `DELETE /captures` removes canonical/index projections and session asset
  aliases. Raw history and shared blobs remain. Complete archive erasure, blob
  collection, and the treatment of these deletions during future reparse are
  separate policy decisions.
- Failure counters are process-local and reset on restart; structured logs are
  the persistent operational evidence when collected by the service logger.
  Successful probes report recovery without clearing accumulated counts.
- Health embeds a fixed diagnostic string on each request, with a two-second
  deadline and cancellation signal. Paid embedding backends incur that request
  cost. Normal built-in provider requests have a ten-second timeout. SQLite lock
  checks may additionally wait up to five seconds.
- Health verifies writability and model reachability, not complete embedding
  coverage. Preserved vectors can remain stale until a successful refresh.
- Existing canonical sessions and SQLite rows load without destructive migration.
  Older canonical files without raw history must be retained. This cannot recover
  payloads or media already lost before deployment.

## Deliberately left for later slices

- **BJS-545:** typed provider parts and raw-to-canonical `reparse`. The raw list/read
  APIs and canonical references are ready; no reparse command was added.
- **BJS-546:** parser drift alerts and durable operational reporting.
- **BJS-547:** expanded provider media discovery/download, including ChatGPT
  `sediment://`, Gemini Canvas/Deep Research/generated media, and provider-specific
  gaps. Existing missing attachments are not backfilled here.
- **BJS-548:** embedding model changes and re-embedding policy.
  `docker-compose.bjslab.yml` and its Ollama/embedding settings are untouched.

## Verification

- Test-first cycles covered raw retention after parser failure, exact-byte batch
  preservation, deduplication, ID isolation, raw write refusal, shared asset
  provenance, canonical hashes, failure reporting, vector retention, stale-text
  exclusion, concurrent query status, concurrent ingest during unify, WAL/timeouts,
  degraded health, bounded embedder probes, and raw backup/restore.
- Final `bun test`: **341 passed, 0 failed**, across 35 files, 951 assertions.
- Final `bun x tsc --noEmit`: **passed**.
- `git diff --check`: **passed**.
- In-memory 3,000-message search experiment: stale-vector filtering initially took
  about 3,842 ms with correlated FTS scans. The final single-scan lookup took about
  43 ms with the same hit count. This is a local measurement, not a production load
  benchmark.
- Two early focused tests timed out during filesystem operations. Subsequent
  focused runs and both full-suite runs passed without raising test timeouts.
- Production files/counts were not inspected, respecting the worktree boundary.
  The reported loss mechanisms were verified against the repository code.

## Deploy requirements

- No new required environment variables, dependencies, or volume mounts.
- The existing `/mnt/server-ssd/chat-scrobbler:/data` mount covers `/data/raw`,
  `/data/canonical/assets`, canonical sessions, and SQLite sidecars.
- The service user must be able to create/write the raw directory, asset hierarchy,
  and index directory. Directories are created automatically when writable.
- After deploying the server, `/health` should report writable stores and either
  available or explicitly disabled semantics. Embedding outages now yield 503,
  which may change external health-monitor behavior.
- Deploy the updated extension build to get client-side failure reports and
  message/URL provenance. Existing v0.3.0 uploads and captures remain accepted.
- New backups contain raw history. Older snapshots do not gain raw data retroactively.
- This file is intended for removal before the PR, as requested.
