# BJS-543: lossless foundation handoff

Implemented on `feat/bjs-543-lossless-foundation`, based on `65ca7d0`.
Changes are committed locally. Nothing was pushed or deployed. No runtime
dependencies or embedding model/config changes were introduced.

## What was built

- Raw storage before parsing or index opening, including all entries of a batch.
  Parser failures leave the original capture available. A raw write failure logs
  a categorical reason and returns a retriable 503.
- Changed endpoint/payload/asset versions preserve incoming JSON bytes in gzip,
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
  raw/.asset-refs/                     # derived ownership catalogue
  canonical/
    sessions/
      <source>/<source_id>.json        # safe legacy filenames unchanged
      .deleted/<source>/<encoded-source-id>.json
      .asset-refs/                     # derived ownership catalogue
    assets/
      .asset-refs/                     # derived ownership catalogue
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

- Dedupe compares the latest session version's endpoint/payload/assets using a stable
  content hash, ignoring timestamps and other envelope fields. Only the first
  envelope of unchanged content is retained. Changed content retains exact bytes;
  its filename hash covers those bytes. A tiny persisted lookup avoids scanning
  history on every capture. Archives lacking the lookup need one discovery scan.
  Old hash formats are upgraded by reading just the pointed-to version once.
- Canonical JSON and lookup files use temp/write/fsync/rename/directory-fsync.
  Immutable raw/blob/metadata publication uses temp/write/fsync/link followed by
  directory fsync. Explicit deletion is the exception to append-only storage.
- Asset aliases preserve extension and existing canonical path compatibility.
  Blobs and aliases must share a filesystem. Backups copy both, so they may
  duplicate bytes; restored aliases can be ordinary copies.
- Write-time ownership catalogues establish shared blob ownership without reading
  unrelated captures. They retain historical links until session deletion. Legacy
  archives need one initialization scan when blob GC is first required; empty
  candidate sets skip it. Restore groups all tombstones before one GC pass.
  Unreadable hash sources log `asset_cleanup_deferred` and retain uncertain blobs.
  Canonical/raw/alias/index deletion still completes. Deferred CAS bytes may need
  later maintenance. Shared blobs retain their original provenance.
- Tombstones discard recaptures with a successful 200 acknowledgement and
  `skipped_deleted`; asset uploads remain 410. They block canonical reads/writes,
  future reparse through the store API, and restoration of deleted content.
  New backups preserve them. Existing local tombstones also apply to forced
  restore. Earlier backups are not modified or remotely erased.
- Failure counters reset on restart; logs provide persistent evidence if retained
  by the service logger. Health calls neither increment embedding failures nor
  emit `embedding_failed`, and report the ingest counter separately from MCP.
- Deep health embeds one diagnostic string per cache refresh with a two-second
  deadline and cancellation signal. Paid backends incur that request cost.
  SQLite lock checks can additionally wait five seconds. Results, including
  failures, are cached for 30 seconds; concurrent probes are coalesced. The index
  probe rolls back its header write and does not reliably detect a full index disk.
- Semantic candidates stream through cosine ranking. Only the bounded top
  candidate window is checked against FTS text. Stale top candidates can reduce
  the returned semantic hit count; removed candidates are not backfilled from
  lower ranks. The query still scans compatible vectors;
  this slice does not add an ANN index.
- Existing canonical data/index rows need no destructive migration. Payloads and
  media already lost before deployment cannot be recovered here.

## Review fixes

The first review findings were checked against the implementation and covered by
regression tests. Finding 1 and follow-on defects were completed in round 2 below.

1. **Polling growth:** endpoint/payload/assets dedupe ignores volatile envelopes; tests
   exercise changed timestamps, cursor, JSON key order, endpoint, payload and assets.
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
   probe table. It does not reliably detect a full disk. A newly created probe
   index is also put in WAL mode.
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
   repeated delete, ignored recapture, and stale snapshot content during restore.
10. **Counters/MCP:** ingest and MCP failure scopes are independent on a shared
    provider. Structured search content contains status without duplicating hits.

## Review fixes, round 2

- **B, legacy sync compatibility:** `POST /captures` returns 200 with
  `{ ok: true, count, spine, skipped_deleted }` even when a deleted chat is
  recaptured. Skipped entries identify `source` and `source_id`; `count` counts
  accepted captures only. A mixed batch stores every live entry's exact JSON
  bytes before parsing. Deleted entries create no new raw/canonical data and do
  not open the index when there are no live entries.
- **B, extension resilience:** ChatGPT, Claude and Gemini sync catch individual
  detail/emit failures, log a categorical reason, count `failed`, and continue to
  later conversations. Any failure keeps the previous sync cursor for retry.
  New background code treats `skipped_deleted` as uncaptured without incrementing
  posted counts. Gemini no longer substitutes DOM data after an ingest failure;
  its fallback is limited to provider RPC failure.
- **C, corrupt-file deletion:** each hash-collection operation is guarded. Invalid
  canonical JSON, gzip, raw JSON, ownership records or legacy asset metadata
  defer blob GC and log a safe reason; canonical files, raw session directories,
  aliases, reference records and index rows are still removed. Tests cover
  corruption, repeated delete, and retention of uncertain blobs for that run.
- **A, asset-aware dedupe:** the stable hash includes `assets`, including pointer,
  SHA-256 and local-path linkage. Upload recovery therefore produces a new raw
  version even when the provider payload is unchanged. Timestamp/cursor changes
  still dedupe. `latest.json` hash version 2 upgrades earlier lookups in place
  without creating a duplicate version for unchanged content.
- **D, cleanup cost:** no candidate hashes means no survivor scan. Raw capture,
  canonical and upload writers maintain asset-to-session references. The
  catalogues live in `.asset-refs` under each respective store root, with
  `owners/<source>/<encoded-id>.json`,
  `by-hash/<sha256>/<source>/<encoded-id>.json`, and a `ready` marker. Writes
  retain historical ownership, bounded by the session's distinct assets, rather
  than by polling timestamps. Legacy stores initialize once, preserving both
  raw links and first-seen upload provenance. New writes then maintain the records.
  Restore invalidates the restored upload catalogue, erases all tombstoned
  content, and performs one shared ownership/GC pass. Tests assert zero survivor
  gzip reads for asset-free deletion and maintained ownership, and at most one
  initialization pass across multiple restore tombstones.
- **Scope/limitations:** no new environment variables, dependencies, volume mounts,
  deploys, pushes or compose changes. The deep-health full-disk limitation and
  top-K non-backfilling behavior remain as described above.

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
- Final `bun test`: **367 passed, 0 failed**, across 36 files, 1,129 assertions.
- Final `bun x tsc --noEmit`: **passed**.
- `git diff --check`: **passed**.
- The first full round-two run hit five-second timeouts in deep health and raw
  backup/restore. The isolated 19-test run and final full run passed without
  changing timeouts (final full run: 6.53 seconds).
- Reviewer scratch scripts were inspected read-only. Their synthetic benchmark
  database was opened read-only. Production data was not inspected or modified.

## Deploy requirements

- No new required environment variables, dependencies or volume mounts.
- The existing `/mnt/server-ssd/chat-scrobbler:/data` mount covers raw, canonical
  sessions/tombstones, assets and SQLite sidecars. Directories are created as
  needed, including derived `.asset-refs` catalogues; the service user needs
  write permission throughout these paths.
- Keep load-balancer liveness on `/health`. Use `/health/deep` with
  `Authorization: Bearer <INGEST_TOKEN>` for operational readiness; without a
  configured token the deep endpoint returns 401. Semantic outage alone is 200.
- Deploy the updated extension for asset failure reporting and message/URL
  provenance and per-conversation sync resilience. v0.3.0 remains compatible
  with successful tombstone acknowledgements.
- Deleted conversations stay deleted even if provider polling attempts recapture.
  Tombstones are included in new backups. Older snapshots gain neither raw
  captures nor tombstones retroactively.
- This file is intended for removal before the PR, as requested.
