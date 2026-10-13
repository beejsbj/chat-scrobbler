# BJS-548 implementation handoff

Branch: `feat/bjs-548-embeddinggemma`. Updated 2026-10-13 after independent review.
Production data and services were not changed. Nothing was deployed or pushed.
The production compose still defaults to Ollama and `nomic-embed-text`.

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
side 768 pixels. Video spans a clip up to 300 seconds, without its audio track.
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
Revision triggers coalesce changes by session; writes refresh affected sessions,
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
Missing or stale vectors themselves are the durable pending marker; no volatile
queue or scheduled job is created. Semantic coverage stays incomplete until a
maintenance backfill runs. A hanging embedder cannot delay a capture.

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
1,081.5 MiB. Keep the eight-frame cap: RSS was below the 1.8 GiB precautionary
threshold. Warm shared model pages explain lower cgroup charge than process RSS;
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

1. Before deploying nonblocking ingest, arrange and verify periodic, nonoverlapping
   backfill batches for the **currently active Ollama/nomic provider**, at nice 19.
   This is a prerequisite on Ollama too: new captures are literal-only until a
   maintenance pass. No scheduler is installed or started by this branch.
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
   Keep Ollama through the rollback window. Arrange and verify a periodic capped
   backfill for new pending captures; no scheduler is installed by this branch.
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

Final checks are green on code at `93573e0`, in disposable Daytona compute with
Bun 1.3.14 and frozen dependencies: **445 Bun tests pass, zero failures**;
**`bun x tsc --noEmit` passes**; Python discovers 42 tests, with **40 passing and
two deployment-renderer tests skipped because cloud Docker Compose is absent**.
Local Python verification passed **all 42, zero skips**, including both compose
rendering regressions. Python source did not change afterward. Tests use fake
engines and synthetic ffmpeg fixtures; native parity/RSS is a separate capped run.

Receipts: `test-results-review-2026-10-13.json`, `python-review-2026-10-13.json`,
`native-review-2026-10-13.json`, and `search-review-2026-10-13.json`, all under
`services/embedder/verification/`. The committed JSON captures the measurements;
raw `.log` files are local diagnostics. The host benchmark preceded the last
identity/snapshot and bounded-block changes; those passed the final suite. The
later cloud benchmark retry hit a GitHub download outage, so no additional speed
claim is made for it. The verifier now retries downloads with bounded waits.

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
Cold matrix loading exceeds the warm target. Asset vectors still use a bounded
streaming scan; production currently has none. Very large sessions cost more to
refresh incrementally. Model/preprocessing changes under an unchanged identity
require rebuilding the affected set; ordinary freshness cannot detect that policy
change. Long audio/video and large blobs need segmentation. Native close retains
allocator memory, and sustained query traffic can delay backfill or expire its
queue wait. The 2 GiB cgroup remains the final memory bound for unexpected inputs.
