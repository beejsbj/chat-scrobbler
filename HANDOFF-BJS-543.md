# BJS-543: lossless foundation handoff

Implemented on `feat/bjs-543-lossless-foundation`, based on `65ca7d0`.
Changes are committed locally. Nothing was pushed or deployed. No runtime
dependencies or embedding model/config changes were introduced.

## What was built

- Raw storage before parsing or index opening, including all entries of a batch.
  Parser failures leave the original capture available. A raw write failure logs
  a categorical reason and returns a retriable 503.
- Changed endpoint/payload versions preserve incoming JSON bytes in gzip,
  including unknown fields and individual batch entries. Unchanged polling skips
  another version. `listRawCaptures` and `readRawCapture` support future reparse.
  New canonical `raw_ref` values are relative to the raw store; legacy references
  still load unchanged.
- Shared SHA-256 asset blobs and provenance metadata: MIME, size, original
  pointer/URL, first session/message and time. Canonical attachments can carry
  `sha256` alongside legacy `pointer` and `local_path`. Existing `/assets` fields
  remain compatible; optional message/URL provenance is accepted.
- Extension download, size and upload failures are logged and reported through
  authenticated `/status`. Failure logs omit URLs and provider error bodies.
- Failed embeddings retain existing vectors while literal indexing continues.
  Categorical logs and process counters expose failures. Search excludes preserved
  vectors whose message text no longer matches the current literal projection.
- MCP keeps its existing JSON hits array in `content[0].text` and adds semantic
  status, reason and failure count in `structuredContent`. Existing array APIs
  remain available. Ingest and MCP counters are separate even with one provider.
- WAL and a 5000 ms busy timeout for index writers. Embedding calls run outside
  write transactions. Unify refreshes in place with guarded pruning and vector
  replacement, plus an embedding circuit breaker.
- Cheap public liveness, authenticated cached deep health, and session deletion
  across canonical, raw, private assets and the index, with durable tombstones.
- Backups include canonical, raw, assets, metadata, config and deletion tombstones.
  Existing snapshots still load; earlier backup erasure is outside this slice.

## Storage layout

Default data root: `~/.local/share/chat-scrobbler`.
Container data root with the existing Dockerfile: `/data`.

```text
<data>/
  raw/<source>/<encoded-source-id>/
    <fetched-at>-<sha256-of-original-bytes>.json.gz
    latest.json                       # replaceable latest content lookup
  canonical/
    sessions/
      <source>/<source_id>.json        # safe legacy filenames unchanged
      .deleted/<source>/<encoded-source-id>.json
    assets/
      sha256/<first-two-hash-characters>/<sha256>       # shared blob
      sha256/<first-two-hash-characters>/<sha256>.json  # provenance metadata
      <source>/<sanitized-source-id>/<sha256>.<ext>    # compatibility hard link
  index/sessions.db
  index/sessions.db-wal
  index/sessions.db-shm
```

For `<data>/canonical/sessions`, raw defaults to `<data>/raw`. Other canonical
layouts use a sibling `raw` directory. Ingest and backup/restore options accept
an explicit `rawDir` programmatically. Raw and tombstone IDs are encoded without
collisions. Canonical paths reject traversal while preserving safe existing
basenames. Tombstones contain only `source`, `source_id`, and `deleted_at`.

## Decisions and trade-offs

- Dedupe compares the latest session version's endpoint/payload using a stable
  content hash, ignoring timestamps and other envelope fields. Only the first
  envelope of unchanged content is retained. Changed content retains exact bytes;
  its filename hash covers those bytes. A tiny persisted lookup avoids scanning
  history on every capture. Archives lacking the lookup need one discovery scan.
- Canonical JSON and lookup files use temp/write/fsync/rename/directory-fsync.
  Immutable raw/blob/metadata publication uses temp/write/fsync/link followed by
  directory fsync. Explicit deletion is the exception to append-only storage.
- Asset aliases preserve extension and existing canonical path compatibility.
  Blobs and aliases must share a filesystem. Backups copy both, so they may
  duplicate bytes; restored aliases can be ordinary copies.
- Deletion scans surviving canonical, raw and upload aliases to establish shared
  blob ownership. This costs archive reads during deletion. Unreadable surviving
  references log `asset_cleanup_deferred` and retain uncertain blobs rather than
  erase another session's data. Shared blobs retain their original provenance.
- Tombstones block recapture and asset uploads (410), canonical reads/writes,
  future reparse through the store API, and restoration of deleted content.
  New backups preserve them. Existing local tombstones also apply to forced
  restore. Earlier backups are not modified or remotely erased.
- Failure counters reset on restart; logs provide persistent evidence if retained
  by the service logger. Health calls neither increment embedding failures nor
  emit `embedding_failed`, and report the ingest counter separately from MCP.
- Deep health embeds one diagnostic string per cache refresh with a two-second
  deadline and cancellation signal. Paid backends incur that request cost.
  SQLite lock checks can additionally wait five seconds. Results, including
  failures, are cached for 30 seconds; concurrent probes are coalesced.
- Semantic candidates stream through cosine ranking. Only the bounded top
  candidate window is checked against FTS text. Stale top candidates can reduce
  the returned semantic hit count. The query still scans compatible vectors;
  this slice does not add an ANN index.
- Existing canonical data/index rows need no destructive migration. Payloads and
  media already lost before deployment cannot be recovered here.

## Review fixes

All ten review findings were checked against the implementation and covered by
regression tests where behavior changed.

1. **Polling growth:** endpoint/payload dedupe ignores volatile envelopes; tests
   exercise changed timestamps, cursor, JSON key order, endpoint and payload.
   Exact original bytes remain available when content changes. `latest.json`
   replaces per-capture directory enumeration/sorting.
2. **Unify pruning:** an empty canonical list with indexed sessions, or removal
   above 10% of the initial session count, logs `unify_prune_refused` and preserves
   absent rows. `chat-scrobbler unify --force` explicitly permits those prunes.
   Missing/unreadable stores still suppress pruning.
3. **Health:** `/health` is unauthenticated liveness only. `/health/deep` requires
   the configured ingest token and caches for 30 seconds. Embedding outage returns
   200 with degraded/unavailable semantics; store/index failure returns 503.
   A rolled-back database header write verifies writability without a persistent
   probe table. A newly created probe index is also put in WAL mode.
4. **Search allocation:** cosine ranking happens first, then FTS validates only
   top candidates. The reviewer's 35,500-message/31,000-vector/768-dimension
   dataset used about 95 MB RSS, versus roughly 1.4 to 2 GB before this fix in
   local runs. The final query took about 12 seconds; these runs do not establish
   a speed improvement. The archive-wide FTS text Map is gone.
5. **Unify embedding safety:** after three consecutive session embedding failures,
   the default circuit opens and remaining sessions receive literal indexing.
   `embeddingFailureLimit` allows a programmatic override. Before vector deletion,
   replacement checks the indexed `updated_at` and the canonical file's mtime,
   inode and size. Concurrent updates or deletion preserve newer vectors.
6. **Durability:** immutable publication flushes its directory; canonical writes
   are flushed atomic replacements. Tests retain an old inode while replacing
   the canonical path and check that readers see complete JSON.
7. **Oversized IDs:** captures bound `source_id` to 200 characters and 240 encoded
   path bytes, and `fetched_at` to 64 characters. Oversized requests return 400
   before writing raw data.
8. **Traversal:** canonical reads/writes/deletes reject separators, dot traversal
   and control characters. Safe legacy names, including dots/spaces, still work.
9. **Deletion:** the authenticated DELETE endpoint removes raw versions, aliases
   and blobs unreferenced by survivors, then index rows. Minimal tombstones are
   durable before cleanup. Tests cover private/shared blobs, raw-only ownership,
   repeated delete, blocked recapture, and stale snapshot content during restore.
10. **Counters/MCP:** ingest and MCP failure scopes are independent on a shared
    provider. Structured search content contains status without duplicating hits.

## Deliberately left for later slices

- **BJS-545:** typed provider parts and raw-to-canonical `reparse`. Use
  `isSessionDeleted` before reparsing; `writeSession` also enforces tombstones.
  The list/read APIs exist; no reparse command was added.
- **BJS-546:** parser drift alerts and durable operational reporting.
- **BJS-547:** expanded provider discovery/download, including `sediment://`,
  Gemini Canvas/Deep Research/generated media and missing attachment backfills.
- **BJS-548:** embedding model changes and re-embedding policy. Compose Ollama and
  embedding settings are untouched.

## Verification

- Test-first cycles cover raw retention/dedupe, asset provenance and failure
  reporting, vector preservation and stale filtering, concurrency, WAL/timeouts,
  prune refusal/force, circuit breaking, cached/authenticated health, atomic
  publication, traversal, oversized requests, deletion and backup/restore.
- Final `bun test`: **354 passed, 0 failed**, across 36 files, 1,024 assertions.
- Final `bun x tsc --noEmit`: **passed**.
- `git diff --check`: **passed**.
- Reviewer scratch scripts were inspected read-only. Their synthetic benchmark
  database was opened read-only. Production data was not inspected or modified.

## Deploy requirements

- No new required environment variables, dependencies or volume mounts.
- The existing `/mnt/server-ssd/chat-scrobbler:/data` mount covers raw, canonical
  sessions/tombstones, assets and SQLite sidecars. Directories are created as
  needed; the service user needs write permission throughout these paths.
- Keep load-balancer liveness on `/health`. Use `/health/deep` with
  `Authorization: Bearer <INGEST_TOKEN>` for operational readiness; without a
  configured token the deep endpoint returns 401. Semantic outage alone is 200.
- Deploy the updated extension for asset failure reporting and message/URL
  provenance. v0.3.0 uploads and captures remain compatible.
- Deleted conversations stay deleted even if provider polling attempts recapture.
  Tombstones are included in new backups. Older snapshots gain neither raw
  captures nor tombstones retroactively.
- This file is intended for removal before the PR, as requested.
