# BJS-548 implementation handoff

Branch: `feat/bjs-548-embeddinggemma`. Updated 2026-10-13 after independent review.
Production data and services were not changed. Nothing was deployed or pushed.
The production compose still defaults to Ollama and `nomic-embed-text`.

## Review fixes, round 2

Rebased onto `origin/main` at `d28ab40` (PR #12, typed parts). Conflicts preserved
reparse/unknown-types commands, opaque-message counts, and canonical tombstone
checks. Parsers and canonical schema were not edited for these fixes.

### Automatic coverage and query priority

`serve` now owns a background job for its active provider. No host timer is needed.
It starts after listeners are up, waits ten minutes by default, and attempts at
most 25 pending text/asset items per batch. Environment settings are forwarded by
the main Coolify compose:

| Setting | Default |
| --- | --- |
| `CHAT_SCROBBLER_EMBED_BACKFILL_ENABLED` | `true`, effective only with a provider |
| `CHAT_SCROBBLER_EMBED_BACKFILL_INTERVAL_MS` | `600000` |
| `CHAT_SCROBBLER_EMBED_BACKFILL_BATCH_SIZE` | `25` |

Each run scans at most 1,000 rows, yields every 100 rows and before inference, and
skips current binary vectors using their input digest/metadata without decoding
all blobs. Underfilled unfinished sweeps continue after one second; filled
batches and completed sweeps wait the configured interval. Thus a covered 31k-row
prefix does not add hours before tail messages are visited. Cursors are in memory;
completed vectors are durable, so restart resumes by skipping current vectors.
Failures stop the batch, advance the sweep to avoid one bad message starving the
rest, and remain pending for the next sweep. Provider outages use exponential
backoff with 0.75–1.25 jitter, capped at one hour with the default interval.

One shared provider gives queued queries priority over documents for
Ollama/Gemini/hash. Gemma uses its existing native queue so a query can dispatch
between a long document's HTTP chunks. Active inference is never preempted.
Background batches omit archive-wide coverage/ETA probes; their scan cursor and
per-batch counts are live. Manual CLI runs retain full coverage and ETA reports.

Authenticated `GET /health/deep` includes `backfill`: enabled/running state,
interval/batch size, next run, consecutive failures, live progress and the last
run's timestamps, outcome and report. This snapshot is read on each request,
independent of the cached filesystem/provider health probe. `/status/report` does
not exist on the rebased main and remains absent.

The CLI, migration-only jobs and scheduler share a process mutex plus an atomic,
PID/nonce-owned lock directory beside the index. A live lock never expires.
Dead owners are recovered only in the same boot/PID namespace. Run manual jobs
with `docker exec` in scrobbler's namespace. SIGTERM/SIGINT stop the job, abort its
request, release its lock and stop listeners; compiled subprocess tests verify
this. A SIGKILL followed by container recreation can leave a foreign-namespace
lock. Recovery fails closed: verify the old container/job is dead before removing
that specific lock. A long manual initial rebuild excludes automatic batches;
use bounded manual batches when active-provider coverage needs time between them.

### Cache refresh, warmup and deadlines

Session indexes exist on both binary and legacy vector tables. `EXPLAIN` confirms
`message_vector_session` and `legacy_vector_session` are used for session refresh;
FTS validation uses its rowid access. Revision triggers distinguish session edits,
model sets, and individual vector writes. FTS edits refresh the session, vector
writeback refreshes only that message using its primary identity index, and
another model/asset set does not rebuild the active text matrix or literal cache.
Retained JSON duplicates no longer hydrate chat text when valid binary identities
are already cached. Removed messages are deleted from both tables during capture
reconciliation even when no inference runs.

After MCP listens, lookup, matrix and lowercase literal cache warm in 64-row
batches that yield between transactions/decoding batches. Initial lookup building
clears old dirty markers because its full sweep already covers them; edits during
the sweep still get catch-up markers. Early queries get FTS literal results and
`semantic: warming`, without waiting for query inference or a synchronous matrix
load. Raw rowid pages are bounded before freshness filtering, so sparse/stale
sets still yield and cancel. Literal refresh/hydration uses a WAL snapshot and
publishes only its reconciled revision; two real-connection regressions reproduce
commits at publication boundaries. Cancellation drains warmup before closing its connection. Gemini/Ollama
requests now always combine their ten-second deadline with a caller signal;
Gemma keeps its per-request 120-second deadline.

Final copy-sized **synthetic bjslab** benchmark at `8e2f29b`, nice 19, CPU quota 200%, RAM 2 GiB,
no swap; started at one-minute load 4.02. Model inference and HTTP transport are
excluded by the fixed provider. Search includes literal recall, ranking,
freshness and merging. There are 35,718 messages, 31,143 vectors, 768 dimensions,
77 MB text and retained JSON alongside binary.

| Measurement | Final |
| --- | --- |
| Background warmup wall time | 5.73 s |
| Query while warming | 2.92 ms, literal hit, `semantic: warming` |
| Largest timer gap during warmup | 29.30 ms, 2,062 timer ticks |
| Warm search median / maximum, five runs | 80.30 / 127.11 ms |
| Search after 5 / 30 / 300 vector writes in distinct sessions | 91.38 / 93.11 / 238.79 ms |
| Other-model write | 93.05 ms, zero sessions refreshed |
| Total process RSS after explicit benchmark GC | 326.63 MiB |

Earlier local stress passes exposed 551 and 462 ms for 300 whole-session
refreshes; message-level invalidation and primary identity lookups removed that
remaining cost. A more contended intermediate pass took 17.66 s to warm and had a
132 ms timer gap. Cooperative yielding does not promise a host scheduling latency
under arbitrary contention. A prior successful pass measured 76 ms warm median and 162 ms after 300 writes.
The matrix allocation remains about 93 MiB. Existing
reviewer measurements of 57–108 ms warm real-copy search and about 410 MiB RSS are
separate evidence; this round did not read the real index. Receipt:
`services/embedder/verification/search-round2-2026-10-13.json`. Reproduce with
`bun scripts/benchmark-search-round2.ts` on bounded disposable data/compute.

### Video margin and final gates

The default is now **four sampled frames**, keeping the 120-second native/client
watchdog. Prior native four-frame inference took 41.91 s; eight-frame decoding and
inference took 91.83 s. Four frames leave more timing margin at the cost of less
temporal detail. Synthetic ten-second decoding and API tests confirm the default
cap. Historical eight-frame receipts and an explicitly eight-frame native probe
are retained. No native inference was rerun in round 2; four-frame spike parity
and default ffmpeg sampling are distinct checks.

Final gates and test receipt are listed under Verification below. Production
provider remains Ollama/nomic. No deployment, production backfill or push occurred.

## Review fixes

The review used a real-index copy with 35,718 messages and 31,143 nomic vectors.
Its findings motivated the regressions and measurements below. This implementation
used synthetic data for verification; it did not backfill or read production chats.

| Finding | Change |
| --- | --- |
| Unwritable cache, dependent production startup | UID/GID 1001, image-owned cache, opt-in sidecar in the main compose, no embedder startup dependency |
| Normal host load blocks rebuild | Serial response-paced requests, optional emergency load brake, migration exempt, ETA |
| Whitespace messages fail | Skip before inference, report skipped, exclude from eligible coverage |
| Empty/oversized titles | Trim, default to `none`, cap at 256 UTF-8 bytes on a character boundary |
| Ingest awaits slow inference | Acknowledge raw/canonical/FTS writes; missing or stale model vectors are pending backfill |
| One message loses session vectors | Commit successful messages individually, retain failures as pending |
| Backfill competes with queries | Query-first waiting queue around the single engine mutex |
| Native media unverified | Native parity and video memory experiment, detailed below |
| Rollback leaves lookup stale | Durable session-change markers and lazy, resumable lookup batches |
| Repeated scans take seconds | One active float32 matrix, incremental session refresh, shared HTTP index connection |
| Close errors/hung engine | Contain close errors; health watchdog detects overdue native work and restarts process |
| Chat text copied per model | New binary rows store a SHA-256 text digest and an empty compatibility text column |
| Runtime depends on spike | Self-contained Python image, immutable model revision plus SHA-256 verification |

## Architecture, API, and deployment

`services/embedder/` is a Python standard-library HTTP service using
`litert-lm==0.18.0`. The quantized generic phone artifact is
`litert-community/embeddinggemma-2-740m-litert-lm`, revision
`24d962e906c7d332c6428e71c9676855024569e2`. Its SHA-256 is
`e7a8a2204b91e0f96e92960e84a09a89212e1633dcb7575a9bf3378b4df77f4c`.
The Docker build fetches and verifies this immutable file into `/opt/models`.
Serving never downloads weights. Native verification alone reuses the already
installed spike venv, HF model, compilation cache, and synthetic fixtures.

One process owns one lazy engine. One mutex covers decoding, load, inference,
pooling, and close. Two waiting requests are admitted; further requests receive
429. Queries precede queued documents, FIFO within each lane. Active work is not
preempted. Queue expiry is 110 seconds. Disconnects drain native work safely.
Idle unload defaults to 300 seconds; later requests reload. Two text/audio threads
are configured; the installed binding does not expose a separate native vision
thread setter. Both engine and per-call vision budgets are 140 tokens per image
or frame. Output is 768 dimensional and L2 normalized.

The provider uses the [Google model card](https://huggingface.co/google/embeddinggemma-2)
query prefix `task: search result | query: {q}` and document prefix
`title: {title or "none"} | text: {doc}`. Titles are trimmed and capped at 256
UTF-8 bytes, without splitting a character. Explicit title plus
`input_format: prefixed` prevents ambiguous delimiters or double prefixes.
The [LiteRT model card](https://huggingface.co/litert-community/embeddinggemma-2-740m-litert-lm)
describes the quantized shared multimodal space.

`POST /v1/embeddings` accepts an OpenAI-style string/string array, with `model`,
`role: query | document`, optional `title`, and ordered `data[index].embedding`.
Token ID input and token accounting are unsupported. A media item looks like:

```json
{"input":{"type":"audio","path":"/data/canonical/assets/sha256/ab/abcdef"},"role":"document"}
```

Media accepts exactly one allowed-root file path or strict `base64`, with type
`image`, `audio`, or `video`. Single images/audio use a bare native media object;
video uses a frame list. Private snapshots, no-follow file access, bounded ffmpeg
threads, direct demuxers, and disabled network/playlist inputs protect decoding.
Audio becomes 16 kHz mono PCM16 WAV, at most 30 seconds. Images/frames have longest
side 768 pixels. Video samples at most four frames across a clip up to 300 seconds, without its audio track.
Bodies are at most 8 MiB, local files 16 MiB, batches eight items, and decoding
30 seconds per item. Larger archived assets need a future segmentation path.

The adapter sends document bodies in sequential requests of at most 8 KiB. The
service splits further at sensible boundaries, at most 1800 UTF-8 bytes including
prefix per native chunk, with a 2048-token context and overflow errors. Service
chunk vectors are normalized, averaged, and renormalized; adapter request vectors
are pooled by body byte weight. Long-message pooling can dilute relevant passages.
A query can wait for the active document request, then precedes queued backfill.

`GET /health` is responsive without the engine mutex. It reports filesystem
readiness, loaded/busy/queued state, RSS, and current native work age. Overdue
load/inference/close reports `status: hung` with HTTP 503. A separate watchdog exits
with status 70 for Compose to restart safely. Native timeout defaults to 120
seconds, configurable up to 300. Idle close exceptions set
`last_close_error: engine_close_failed` and do not kill `serve_forever`.
Filesystem readiness is not proof of successful inference.

Chosen deployment: `services/embedder/Dockerfile` and the opt-in `embedder` service
in **`docker-compose.bjslab.yml`**, the file Coolify already deploys. No overlay is
required. `services/embedder/compose.embedder.yml` is now an empty compatibility
overlay; all service definitions live in the main compose. This choice preserves one deployment plan
when Coolify recreates services.

Enable the profile explicitly with `COMPOSE_PROFILES=embeddings` in the Compose
invocation. Coolify must pass that setting to its actual Compose process; verify
its rendered service list before deploying. Scrobbler still starts on Ollama if
this profile is absent or the sidecar is unhealthy. It has no dependency on
embedder health. Environment interpolation leaves current defaults intact and
permits a later explicit provider/model switch. The private base URL is already
`CHAT_SCROBBLER_EMBED_BASE_URL=http://embedder:4320` for provider overrides.

The embedder runs as `1001:1001`; its image provisions `/var/cache/embedder` with
that ownership. Docker initializes the named `embedder-cache` volume from it.
Previously populated volumes must be checked for ownership before deployment.
Canonical assets are mounted read-only at `/data/canonical/assets`. The sidecar
has only an internal Docker network, no published ports or proxy network. Local
execution binds loopback; Docker wildcard binding requires explicit private mode.
Browser Origin requests are rejected; trusted callers share the private network.

Caps: **2 CPUs, 2 GiB RAM, zero swap, nice 19, two backend threads**, 64 PIDs,
`cap_drop: ALL`, `no-new-privileges`, and one worker process. Equal `mem_limit` and
`memswap_limit` disable swap. The watchdog and `restart: unless-stopped` recover
hangs/OOM. Container build and deployed permissions/cgroups remain smoke gates;
no image was built or service started for this change.

## Storage, lookup, and search measurements

Binary vectors are portable little-endian float32 BLOBs, scoped by
`(provider_kind, provider_model, dimension)`. Model sets coexist. Search chooses
only the queried provider's exact set, plus its asset set. `sqlite-vec` was not
added: the measured matrix scan is small enough under Bun without a native
extension dependency.

Legacy `message_embeddings` JSON stays intact. `--migrate-only --limit N` converts
bounded pages of 100, recording a durable rowid cursor; invalid rows are reported
and never retried forever. Existing newer binary rows are not overwritten. Normal
backfill also reuses valid matching JSON without inference and repairs corruption.
New binary rows use `text_hash`; previous binary rows with a full `text` remain
readable through a compatibility path. This additive schema change neither erases
legacy vectors nor rewrites source data. Re-ingesting/backfilling validates current
text, title, model, and dimensions.

`message_lookup` now opens cheaply and builds only on demand, in resumable
500-row transactions. Session triggers leave durable dirty markers even when an
old executable writes FTS during rollback. New indexing maintains mappings and
clears its marker; a later search/coverage pass catches up old-writer changes.
A first-open migration no longer builds the whole lookup under one long writer
transaction. Busy timeout remains five seconds per connection.

Search lazily loads **one active model matrix per open index**, normalizing once.
Its matrix for 31,143 x 768 is 95,671,296 bytes, about **91.2 MiB** used, with 93 MiB allocated in 1024-row blocks, plus identity
metadata. Growth adds one block instead of doubling the matrix. Text stays in FTS and is fetched only for winning semantic rows.
Revision triggers scope vector changes by model and message; FTS edits refresh affected sessions,
and model switches replace the reachable matrix. Data-version/change counters
also detect other connections and untracked writes; decreasing revisions after a
rollback force a reload. Hydration checks identity and input digest in a consistent
read snapshot, so reused rowids cannot attach replacement text to a deleted message. The HTTP MCP service owns a
shared connection across stateless transports, so requests keep the warm matrix.
A fresh CLI invocation still pays the initial load.

Synthetic benchmark: 35,718 messages, 31,143 vectors, 768 dimensions, 77 MB of text,
retained JSON plus binary rows. No real chat text was used. Complete search here
includes literal/substring recall, vector ranking, freshness, snippets, and merging;
query model inference/network time is excluded by a fixed synthetic provider.

| Measurement | Before | After |
| --- | --- | --- |
| Warm complete search median | 996 ms | 141 ms |
| Warm complete search maximum, five runs | 999 ms | 157 ms |
| Initial lazy matrix/lookup load plus search | 1,014 ms | 1,271 ms |

These are disposable Daytona measurements, not host/production latency claims.
Cold initialization is explicit and is above the 300 ms warm-search target.
Profiling found substring SQL about 106 ms, binary row reads 66 ms, validated FTS
joins 164 ms, arithmetic for 31k cosines 24 ms, and top-K sorting 1.2 ms. Those are
independent passes, not additive timings. Callback-based finite checks took about
700 ms more in a prior run; an inline finite loop reduced decode/read to 93 ms.
The matrix removes repeated decoding, norm calculation, and FTS joins. The first
version still scanned substring text on every query; the final version adds a
shared lowercase literal cache and refreshes changed sessions. Winner hydration
validates identity, source, and the actual substring. The all-in-memory benchmark's total RSS
was 1.30 GiB including its generated SQLite database and retained JSON; that is
not the memory cost of the matrix. The file-backed HTTP MCP benchmark initially measured 189 ms median, 197 ms
maximum, 1.95 seconds cold, and 195 MiB RSS in Daytona.

A capped **bjslab** run exposed the remaining substring I/O: matrix-only HTTP
search took 634 ms median and 889 ms maximum. Adding the literal cache brought
complete HTTP MCP search to **64 ms median, 144 ms maximum**, five warm requests,
with **406 MiB total process RSS**. This includes SDK transport and response
parsing, and excludes model inference. Cold initialization took 5.60 seconds.
The 91 MiB vector matrix is one part of that footprint: lowercase text, identity
metadata, SQLite/JSC allocations, and runtime consume the remainder. This is an
explicit RAM cost to remove repeated archive scans; raw text payload in this
fixture is 74 MiB, while strings and other allocations increase measured process
RSS by about 207 MiB over the matrix-only run. The live service's footprint must
be monitored as the archive grows.

These finite tests used `MemoryMax=2G`, zero swap, 200% CPU quota, nice 19 and
120-second runtime limits, starting below load 8. They generated disposable
synthetic files and removed them afterward. No model or production index was used.
Systemd's final summary sometimes understates peak memory; use the measured process
RSS. Receipts: `search-host-{review,final-review}-2026-10-13.log`.

Reproduce: `bun scripts/benchmark-search-review.ts --assert` on disposable compute,
or `sh scripts/verify-bjs-548.sh scripts/benchmark-search-review.ts --assert` for
pinned Bun 1.3.14. The assertion checks a five-run warm median below 300 ms.

## Backfill and pending ingest vectors

Ingest persists raw, canonical, FTS, and asset ownership before acknowledgement.
It never calls a model inside `POST /captures`, even when one is configured.
Missing or stale vectors themselves are the durable pending marker. The serve
scheduler processes them automatically; manual backfill handles initial rebuilds
and full coverage/ETA checks. A hanging embedder cannot delay a capture.

```sh
chat-scrobbler embed-backfill \
  --provider embeddinggemma \
  --model litert-community/embeddinggemma-2-740m-litert-lm \
  --limit 100 --rate 10 --load-threshold 32

chat-scrobbler embed-backfill --migrate-only --limit 1000
```

Provider/model overrides affect only that invocation. The production provider can
remain Ollama throughout a Gemma rebuild. Run the job at nice 19 and keep inference
inside the embedder's capped cgroup. Only one backfill request is outstanding;
responses/back-pressure determine throughput. `--rate` defaults to 10 requests/s
and yields 100 ms between responses, including adapter chunks, rather than adding
five seconds per message. The optional `--load-threshold 32` is an emergency brake;
there is no load guard by default. Migration-only needs no inference/load gate. Lazy JSON conversions inside a normal
backfill still obey its optional emergency gate, but never call the model. Abort waits and requests with SIGINT/SIGTERM; completed
rows survive. A request already computing safely drains.

Every message/asset commits separately. Indexing also retains successful messages
if another message in the session fails. Retry skips valid current vectors, while
failed/missing/stale rows remain pending. Whitespace-only messages count as skipped
and are excluded from eligible coverage. Changed text/title or deletion during a
request prevents stale writeback or resurrection. FTS rowids can move during
capture, so repeat a pass until coverage settles.

Progress reports embedded, converted, skipped, failed, stale, attempted, current
text/asset coverage, request counts, estimated native chunks, request latency,
elapsed time, and ETA. Initial ETA assumes two seconds per native text chunk plus
pacing; later ETA uses observed request response time. It is approximate for word
boundaries, configured chunk budgets, load pauses, media, and concurrent captures.
The supplied budget of about 53k chunks is **29.4 hours of compute**, plus pacing,
pauses, and retries. Limits apply to attempted missing/changed rows, including
conversion and failures. Genuine failures produce a nonzero exit; whitespace does
not. Load-pause reports reuse their last coverage snapshot.

## Multimodal ownership

Literal indexing records asset SHA links, including empty-text messages. Backfill
embeds each distinct owned `(sha256, provider_kind, provider_model, dimension)`
once, then semantic asset hits map to every owning message/session. Blobs resolve
through `canonical/assets/sha256/<2>/<sha>`. Shared owners survive individual
session deletion; unowned derived vectors are pruned for affected hashes only.
Images/audio, named video files, and the future video block hook require no parser
schema changes. BJS-547 must supply captured hashes and supported media kinds.
All verification assets are synthetic. No production assets exist or were created.

## Native latency and RSS

The initial implementation measured text-only unload: baseline 15.9 MiB, loaded
343.4 MiB, immediate close 198.6 MiB, settled 15 seconds 198.4 MiB, reload/text
2.84 seconds at 366.7 MiB. Close released 144.8 MiB but retained 182.5 MiB above
baseline. These page-cache-warm, contended observations are not latency promises.

Native review runs used effective `MemoryMax=2G`, `MemorySwapMax=0`,
`CPUQuota=200%`, nice 19, two threads, and a 300-second transient lifetime. Every
run checked one-minute load before launch and exited if it rose above 8. Three
partial attempts backed off on load; their completed stages remain valid evidence.
No inference worker was left running.

| Modality | Wall latency | RSS after inference | Cosine vs stored spike vector |
| --- | --- | --- | --- |
| Text query, lazy load included | 1.04 s | 356.0 MiB | 1.0, zero maximum delta |
| Image, bare native input | 10.73 s | 857.1 MiB | approximately 1.0, max delta 2.98e-8 |
| Audio, decoded 16 kHz mono | 15.02 s | 1,154.8 MiB | 1.0, max delta 1.19e-7 |
| Exact four spike video frames | 41.91 s | 995.4 MiB | approximately 1.0, zero maximum delta |
| Eight-frame ffmpeg video path | 91.83 s | 1,445.0 MiB | no stored eight-frame reference |

All returned 768 finite floats with norm within about 2e-7 of one. A cosine just
above one in the logs is float32 arithmetic rounding. Four-frame parity used the
same original files; the eight-frame request exercised the actual service decoder.
Eight-frame **peak RSS was 1,452.0 MiB (1.42 GiB)** and observed cgroup peak was
1,081.5 MiB. RSS was below the 1.8 GiB precautionary threshold, but round 2
lowers the default to four frames for watchdog margin. Warm shared model pages explain lower cgroup charge than process RSS;
a fresh image/container must still be measured, and larger shapes remain bounded
by the 2 GiB hard cap.

After that video, `close()` dropped RSS from 1,445.0 to **213.7 MiB** immediately
and remained 213.7 MiB through 15 seconds of settling, compared with a 15.9 MiB
baseline. The allocator retains about 197.8 MiB. Unload releases substantial memory
but does not restore the original process baseline. These experiments do not prove
allocator stability over many repeated cycles. Eight-frame latency is close enough
to the 120-second native/client timeouts that contention or queueing can cause
retries; queued queries cannot preempt an active video.

Receipts: `services/embedder/verification/native-{review,video-final,eight-review}-2026-10-13.log`.
The systemd summary in these logs sometimes reports an implausible KiB memory peak;
use the explicit `/proc` and `memory.peak` samples above instead.

## Cutover and rollback, not executed

1. Verify the automatic scheduler is enabled for the **currently active
   Ollama/nomic provider** and advances through pending rows in deep health.
   No host timer is required. Verify graceful stop/lock cleanup under Coolify.
   Verify backups, index location, disk budget for both sets, and cache/asset
   permissions. Merge reviewed code, then have Coolify deploy the main compose
   with its explicit embeddings profile. Keep provider/model on Ollama/nomic.
   Coolify may recreate scrobbler; capture remains safe and inference-independent.
   Verify effective cgroups, UID/cache write access, private connectivity, health,
   synthetic text/media, watchdog behavior, and idle RSS. Check the selected frame
   cap against actual assets. Do not expose a port publicly.
2. **Backfill first.** Within the private caller network, invoke the job with
   `--provider embeddinggemma --model ...`, first with `--limit 100`, then resumable
   batches. Keep Ollama serving recall. Monitor coverage, failure/stale counts,
   ETA, RSS, and throttling. Do not use `unify` as the bulk inference job.
3. Verify eligible text coverage after a settling pass, investigate failures,
   and compare both model sets with one-off provider overrides on the same archive.
   Burooj should judge actual results for queries such as “why did semantic recall
   disappear when the server was swapping?”, “what did we decide about preserving
   raw chat captures?”, “where did I discuss sincerity and ikhlas?”, and “what is
   the phone and server embedding plan?”. Check paraphrases, literal anchors,
   inactive branches, irrelevant ranks, and warm/cold/query-inference latency.
   Compare synthetic media captions first, and approved captured assets after
   BJS-547. Compare phone vectors with identical artifact/preprocessing.
4. **Switch second**, only after accepted coverage and quality: set
   `CHAT_SCROBBLER_EMBED_PROVIDER=embeddinggemma`,
   `CHAT_SCROBBLER_EMBED_MODEL=litert-community/embeddinggemma-2-740m-litert-lm`,
   and base URL `http://embedder:4320`, then let Coolify recreate scrobbler.
   Keep Ollama through the rollback window. Verify deep health shows the automatic
   job for the new active provider and that pending captures receive vectors.
5. After stable operation, remove the Ollama dependency/service. Retain its volume
   for an agreed rollback window. Deleting nomic, unused `qwen3:4b`, or the roughly
   2.8 GB `/mnt/server-ssd/ollama` store requires separate destructive approval.
   The new deployment has no dependency on deleting/retaining the spike runtime.

Rollback: stop the Gemma job, restore provider `ollama`, model `nomic-embed-text`,
and `OLLAMA_BASE_URL=http://ollama:11434`; recreate scrobbler with the capped Ollama
service/dependency. The nomic set remains intact. Backfill nomic for messages
captured/changed during the Gemma interval; literal recall works meanwhile.
Disable the embeddings profile after callers switch. Old application binaries
can use retained JSON but require nomic rebuild for recent binary-only messages.
Returning to this branch catches up its lookup through the rollback change markers.

## Verification and open risks

Final checks are green at `8e2f29b`, in disposable Daytona compute with Bun 1.3.14
and frozen dependencies:

- **522 Bun tests pass, zero failures**, 60 files and 2,047 assertions.
- **`bun x tsc --noEmit` passes**.
- Python discovers 45 tests: cloud has 43 pass and two Docker Compose renderer
  skips; **local has all 45 pass, zero skips**, including deployment rendering.
- **`bun build --compile src/cli/chat-scrobbler.ts` passes**, and the compiled
  binary runs **`embed-backfill --help` with exit 0**. The suite also exercises
  compiled serve shutdown during an active backfill request.
- The final capped host benchmark passes its warming/coverage and under-300-ms
  warm/refresh assertions. The bounded review found no remaining definite issues
  after fixing its concurrent literal-revision race and sparse-page finding.

Run `sh scripts/verify-bjs-548.sh` on disposable compute for all portable gates.
Local Python: `python3 -m unittest discover -s services/embedder/tests -v`.
Round-2 receipts: `test-results-round2-2026-10-13.json` and
`search-round2-2026-10-13.json` under `services/embedder/verification/`.
Earlier `*-review-2026-10-13.json` receipts preserve the round-1 native, RSS,
search and test evidence. No native model inference was repeated in round 2.
Tests use fake engines and synthetic ffmpeg fixtures. Cloud sandbox deletion was
verified; all host benchmark units ended and removed their synthetic databases.

Regressions cover title normalization/UTF-8, whitespace skip and exit behavior,
load and migration exemptions, chunk/request ETA, success-only latency samples,
pending capture ACK with hanging providers, partial failures/retry, provider
isolation, digest/legacy freshness, rollback lookup healing, rowid reuse, multiple
connections, rolled-back transactions, query priority, close exceptions, hung
native load/inference/close watchdogs, private deployment and cache ownership.
A deterministic diagnostic committed a different connection's rowid replacement
between vector ranking and hydration: the original snapshot retained correct
provenance, and the following search observed deletion.

Remaining operational gates: actual Docker build/start smoke, Coolify profile
propagation and effective limits, real-archive quality/latency, and phone agreement.
Cold matrix loading still costs seconds in total but now yields in the background; early serve queries use literal recall. Asset vectors still use a bounded
streaming scan; production currently has none. Very large sessions cost more to
refresh incrementally. Model/preprocessing changes under an unchanged identity
require rebuilding the affected set; ordinary freshness cannot detect that policy
change. Long audio/video and large blobs need segmentation. Native close retains
allocator memory, and sustained query traffic can delay backfill or expire its
queue wait. Foreign-namespace locks after abrupt container death require verified
manual recovery; graceful Coolify termination releases them. The 2 GiB cgroup remains the final memory bound for unexpected inputs.
