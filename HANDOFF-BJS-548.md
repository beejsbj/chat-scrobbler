# BJS-548 implementation handoff

Branch: `feat/bjs-548-embeddinggemma`, based on `main` at `29fdfd8`.
Date: 2026-10-13. Implementation and synthetic verification are complete. Production
provider configuration, data, and services were not changed. Nothing was pushed.
Deployment, real archive quality checks, and complete native media/RSS measurements
remain cutover gates.

## Architecture and runtime

`services/embedder/` contains a small Python standard-library HTTP service. It
reuses `venv-a` with LiteRT-LM 0.18.0, the generic 485 MB quantized model from
`litert-community/embeddinggemma-2-740m-litert-lm`, and the spike's existing HF and
compilation caches. Snapshot: `24d962e906c7d332c6428e71c9676855024569e2`. There is
no model download path. Model loading happens on the first valid request.

One process owns one engine. One lock covers media snapshots, decoding, model
load, inference, and pooling. Two waiting requests are admitted; further requests
receive 429. Waiting expires after 110 seconds with 503. Disconnecting a caller
does not release an in-flight engine lock. Health remains responsive. The HTTP
loop checks idle state every 0.5 seconds and closes the engine after 300 seconds;
a later request loads it again. Idle close is tested with fake engines.

Text/audio backends use two threads. Vision receives the same setting, but the
installed binding does not forward a separate vision thread count to native
settings. The CPU quota remains the enforceable total CPU bound. Both engine and
per-call options explicitly set 140 vision tokens per image/frame. Input overflow
raises an error rather than truncating silently. Native context is capped at 2048
tokens; service text chunks include at most 1800 UTF-8 bytes, including prefix.

The [Google model card](https://huggingface.co/google/embeddinggemma-2) specifies
query/document prefixes and 16 kHz mono audio. The
[LiteRT model card](https://huggingface.co/litert-community/embeddinggemma-2-740m-litert-lm)
describes the quantized multimodal build and its 768-dimensional shared space.
The installed-source audit verifies the actual Python/FFI settings without
loading the engine: `python3 -B -m services.embedder.verify_api`.

## API and adapter

`POST /v1/embeddings` accepts an OpenAI-style text string or string array, with
`model`, `role`, optional `title`, `dimensions`, and `encoding_format`. Token ID
input and token usage accounting are unsupported. Default role is document.

```json
{"input":"bread notes","role":"document","title":"Recipes"}
```

The multimodal input is an object or an item in an input array:

```json
{"input":{"type":"audio","path":"/data/canonical/assets/sha256/ab/abcdef"},"role":"document"}
```

Use `type: image | audio | video` and exactly one `path` or strict `base64` value.
Paths must resolve beneath configured roots. URL inputs, path traversal, outside
symlinks, non-files, indirect media playlists, and network decoding are rejected.
Inputs are copied to bounded private snapshots and removed after each request.

Responses contain `object: list`, `model`, and ordered
`data[index].embedding`. Default output is 768 normalized floats; direct API
callers may request 512, 256, or 128 with renormalization, or float32 base64.
The scrobbler adapter always requests/validates the full 768-dimensional space.

`GET /health` reports `status`, canonical model ID, filesystem `model_available`,
`loaded`, `busy`, configured thread/vision budgets, idle timeout, and current RSS.
Filesystem readiness does not prove successful inference. `doctor` probes this
contract and reports coverage for the configured model rather than another set.

Configuration:

```sh
CHAT_SCROBBLER_EMBED_PROVIDER=embeddinggemma
CHAT_SCROBBLER_EMBED_MODEL=litert-community/embeddinggemma-2-740m-litert-lm
CHAT_SCROBBLER_EMBED_BASE_URL=http://embedder:4320
```

For a host CLI/local test the URL defaults to `http://127.0.0.1:4320`.
The JSON config equivalent adds `embeddingBaseUrl`.
`EmbeddingGemmaProvider.embed()` formats queries as
`task: search result | query: {q}` and documents as
`title: {title or "none"} | text: {doc}` using existing context. It sends
`input_format: prefixed` and an explicit document title, preserving delimiters
inside titles without adding a second prefix. Media receives no prefix.
`embedAsset()` accepts all three media types with query/document context.

Long documents are split into sequential requests of at most 8 KiB of body,
preserving Unicode and whitespace and preferring paragraph/word boundaries.
The service splits each request further at paragraph/sentence/word boundaries,
then normalizes the mean of its chunk vectors. The adapter pools request vectors
weighted by body bytes and renormalizes. This produces one message vector, so a
small relevant passage in a very long message can be diluted. Phone/server
comparisons must use the same prefixes, vision budget, artifact, and chunk/pooling
policy; sharing a model name alone does not guarantee identical message vectors.
Each HTTP request has a 120-second deadline plus caller cancellation.

## Media bounds

- Images/frames are scaled to a longest side of 768 pixels, preserving aspect.
- Audio is converted by ffmpeg to 16 kHz mono PCM16 WAV. Inputs above 30 seconds
  are rejected; actual decoded duration is checked too.
- Video is capped at 300 seconds and eight sampled frames spanning the clip,
  including a frame in its final tenth. Frames are passed together as images.
  Video audio is not included.
- Bodies are limited to 8 MiB, local files to 16 MiB, and batches to eight items.
  A media probe/decode has a total 30-second deadline. Oversize/unknown-duration
  media is rejected rather than silently losing its tail.

These bounds protect the current host at a cost: larger/longer assets need a future
segmentation path. The capture store accepts up to 50 MiB, so some future BJS-547
assets can be archived successfully yet require segmentation before embedding.

## Deployment artifacts and caps

Chosen deployment: `services/embedder/Dockerfile` plus
`services/embedder/compose.embedder.yml`, merged after the existing production
Compose file. This fits the current Docker caller and reuses the existing venv
and caches. A host-only systemd listener would be unreachable from that caller.
The image uses Ubuntu 24.04/Python 3.12 to resolve the venv's existing interpreter
symlink. Building installs OS packages, including ffmpeg, but no Python packages
or model weights. Image/venv ABI execution still needs a deployment smoke check.

The overlay attaches scrobbler to its existing network plus an internal embeddings
network. The embedder has only the internal network, no published ports and no
proxy connection. `private-docker` is an explicit binding mode; local execution
otherwise binds loopback. It has no bearer authentication; its caller network and
local processes are trusted. Browser Origin requests are rejected.

Resource caps are `cpus: 2`, `mem_limit: 2g`, `memswap_limit: 2g`, `pids_limit: 64`,
`init: true`, and `nice 19`. Equal RAM and RAM-plus-swap limits mean zero swap.
HF cache, venv, and canonical assets are mounted read-only; LiteRT compilation
cache stays writable. All bind sources must already exist. A 2 GiB limit bounds
failure impact; it does not establish that every admitted media input fits.

The overlay's healthcheck verifies filesystem readiness without eagerly loading.
It leaves the production provider/model environment unchanged. Compose resolution
was checked without printing its environment or starting services.

## Measured latency and memory

The BJS-544 spike measured native text/image/audio/four-frame video successfully:
short query about 0.25 s, ~1900-token document 8.4 s, image 6.8 s, 29-second speech
12.1 s, four-frame video 29.5 s, and multimodal peak RSS around 1.1 GiB. Those used
four threads and an 8192-token context on a contended host. They are historical
context, not measurements of this wrapper's two-thread/2048-token configuration.

A finite capped wrapper run was attempted using the existing venv and synthetic
spike fixtures. It started at one-minute load 7.73, confirmed 2 GiB RAM / zero
swap / 200% CPU / nice 19, and recorded:

| Stage | Time | Current RSS |
| --- | --- | --- |
| Before native import | baseline | 16,364 KiB |
| Native load | 2.04 s | 249,216 KiB |
| Lazy load plus short text | 3.22 s total | 351,832 KiB |

Load then rose to 9.11; the watchdog exited 75 after 4.283 seconds. Systemd reported
419.5M peak cgroup memory and zero swap. Receipt:
`services/embedder/measurement-2026-10-13.json`.
A second idle-first run started at load 7.46 and completed the first unload and
reload:

| Stage | Time | Current RSS |
| --- | --- | --- |
| Baseline | before import | 15.9 MiB |
| Native load | 0.95 s | 243.7 MiB |
| Lazy load plus short text | 1.43 s total | 343.4 MiB |
| Immediate idle close | after 1.1 s idle | 198.6 MiB |
| Settled after close | 15 s | 198.4 MiB |
| Reload plus short text | 2.84 s | 366.7 MiB |

Close released 144.8 MiB immediately, but 182.5 MiB above baseline remained after
15 seconds. **Idle unloading releases memory without returning the process to
baseline.** This is one text cycle, not evidence about long-term growth or media
unload. The watchdog stopped work during media at load 8.21, RSS 740.5 MiB, after
26.233 seconds. Zero swap was confirmed. Systemd's second-run peak summary was
inconsistent with sampled RSS/cgroup memory and is excluded. Receipt:
`services/embedder/measurement-idle-first-2026-10-13.json`.

The measurement script records current RSS immediately and at 1/5/15 seconds
after close, reload, and a second unload; it prioritizes text idle-unload before
media.
Repeat `python3 -B -m services.embedder.measure` when one-minute load stays below 8.
It verifies effective transient cgroup limits and aborts if load rises above 8.
The process has a five-minute runtime ceiling and leaves no resident service.

## Storage and migration

New vectors are explicit little-endian float32 BLOBs, 3072 bytes for 768 values.
`message_vectors` keys each row by message identity plus
`(provider_kind, provider_model, dimension)`. `asset_vectors` uses SHA-256 plus the
same scope. Different model sets coexist; search uses only the query provider's
kind/model/dimension. No `sqlite-vec` dependency was added.

Legacy `message_embeddings` JSON rows remain intact. Search reads unconverted
rows, avoiding duplicates where a usable matching binary snapshot exists.
Malformed binary vectors can fall back to valid JSON. Normal backfill converts
only matching legacy snapshots lazily and repairs malformed binary data without
calling the model. Ingest writes only binary rows.

A separate resumable conversion is available:

```sh
chat-scrobbler embed-backfill --migrate-only --limit 1000
```

It scans old rowids in 100-row transactions, persists a `vector_migration` cursor,
retains corrupt/unknown-scope source rows, skips existing binary snapshots, and
never overwrites newer binary data. Restart continues from the cursor. It pauses
above the host load threshold; no inference occurs. JSON is not removed and
SQLite is not vacuumed, so this pass temporarily increases disk use. Old binaries
can still read their original JSON; they do not see newly computed BLOB-only rows.

`message_lookup` adds an indexed message identity to FTS rowid map, initialized
once from existing FTS rows and maintained with literal indexing. Vector search
joins through that rowid and checks current text/title before candidates consume
ranking slots. Retained stale model sets therefore cannot hide live results.
The map stores identities/rowids, not another copy of chat text. Search streams
vectors with a bounded candidate window and calculates cosine in TypeScript.
It remains a linear scan in the selected model's vector count.

Synthetic storage benchmark in Daytona, 4096 messages at 768 dimensions, median
of three complete search calls with identical vectors:

| Encoding | Vector payload bytes | Median search |
| --- | --- | --- |
| Float32 BLOB | 12,582,912 | 99.3 ms |
| JSON | 65,957,888 | 157.0 ms |

This excludes model latency and is not a production archive benchmark. Float32
rounding is expected; cosine uses actual norms. Reproduce with
`bun run scripts/benchmark-vector-storage.ts` on disposable compute. Receipt:
`services/embedder/verification/vector-benchmark-2026-10-13.json`.

## Backfill behavior

```sh
chat-scrobbler embed-backfill \
  --provider embeddinggemma \
  --model litert-community/embeddinggemma-2-740m-litert-lm \
  --limit 100 --rate 0.2 --load-threshold 8
```

`--provider` overrides only this invocation, allowing the new set to be built while
recall still uses nomic. `--model` is required for inference. `--rate` is maximum
items per second, where an item is a message or asset; one long message can require
several serial HTTP requests. Defaults are 0.2 items/s and load threshold 8.
`--limit` bounds attempted missing/changed items, including failures and lazy JSON
conversions. Conversions are throttled, load-checked writes and are reported
separately as `converted`; they do not invoke the model. Matching text,
title, provider/model and dimension are skipped. Unknown-dimension providers such
as Ollama inspect matching current rows across stored dimensions. There is no
unlimited automatic migration before a bounded normal backfill.

Load is checked before inference and, for EmbeddingGemma, before each text chunk
request. High load pauses in five-second intervals; it does not cancel a native
request already running. Messages are checked for current text/title before
request dispatch, after each per-request load wait, and again inside the write
transaction. A deletion/edit during
inference prevents vector resurrection. Completed items commit individually, so
interruptions and failures retain progress. Restart scans for missing/changed
items; no fragile long-job offset is required. Concurrent ingests can move FTS
rowids, so a second pass settles coverage after ongoing capture activity.

JSON progress at start, every 25 attempts, load pauses and completion includes
embedded/converted/skipped/failed/stale/attempted, text coverage, and asset coverage.
Coverage validates finite vectors and current inputs. Load pauses reuse the most
recent snapshot, identified by `coverage_at_attempt`; initial paused coverage is
null. This avoids repeatedly scanning vectors while the host is busy.
No chat text, private paths or provider response bodies appear in these reports.
The CLI exits nonzero if items failed, inviting a resumable retry. SIGINT/SIGTERM
cancel waits and client requests and leave completed vectors intact. Limits and
rate/load controls are validated before opening the index.

The supplied 35.7k/4.4k archive counts were not independently surveyed. At five
seconds of delay per missing message, 35.7k new vectors alone require at least
about 49.6 hours, plus inference and load pauses. The 4.4k without any vector are
included in a new-model rebuild; the nomic vectors do not count as Gemma coverage.

## Multimodal ownership and search

Literal indexing records SHA-256 attachment links even for empty-text messages.
Image/audio attachments are supported now; named video file attachments and
future runtime `kind: video` blocks have a hook without changing parser/schema
contracts. BJS-547 must supply hashes and media kinds; unsupported file types are
not guessed as images or audio. Existing canonical blobs are resolved through
`assetBlobPath()`, under `canonical/assets/sha256/<2>/<sha>`.

Backfill embeds each distinct owned SHA once per provider/model/dimension and
retains every owning message/session link. Search combines text and asset cosine
candidates, deduplicates messages, and maps an asset hit back to its owners using
current source/title/role metadata. Empty-text hits display `[Media attachment]`.
Asset vectors are embedded by the backfill/API hook; ingest records ownership but
does not synchronously run media inference.

Removing attachments or deleting sessions removes links and prunes vectors only
for affected hashes with no remaining owner. Shared assets survive. This cleanup
is bounded to that session's hashes. Hashes/paths are derived; raw captures and
immutable asset bytes remain the source of truth. All media tests use synthetic
fixtures. No production assets or backfill were used.

## Cutover and rollback plan

These are proposed operational steps, not executed commands.

1. Keep the nomic set and Ollama volume. Verify the existing backup and index
   location. Merge/build the implementation after review. Check all bind sources,
   Python/venv ABI, ffmpeg, cgroup enforcement, and allowed-root permissions.
2. Add the private embedder overlay with the production Compose file first.
   Validate with `docker compose ... config --quiet`. Deploy only the embedder
   initially; do not run a broad `up` that recreates scrobbler early. Verify private
   connectivity from the caller network, health, a synthetic text/media request,
   and both idle unload RSS cycles. Confirm the maximum eight-frame case fits the
   2 GiB cap. Inspect effective limits, not just YAML.
3. For the requested switch-first sequence, deliberately set scrobbler's provider,
   model and `CHAT_SCROBBLER_EMBED_BASE_URL=http://embedder:4320` and recreate it.
   Recall continues with literal search plus only the partial new semantic set
   until backfill finishes. A lower-disruption alternative is to complete step 4
   using `--provider embeddinggemma` before switching; choose this cost explicitly.
4. Run capped, low-priority backfill inside the private caller network, first
   `--limit 100 --rate 0.2`, then resumable batches. Keep load threshold 8 and monitor
   failure/stale counts. Production already contains literal rows; avoid `unify`
   as the initial bulk inference job. Re-run until current text coverage settles,
   and investigate each remaining missing vector. Continue with future asset
   coverage after BJS-547 capture lands. No raw/canonical migration is required.
5. Compare the two providers against the same archive with one-off CLI environment
   overrides. Burooj should judge the actual returned threads. Suggested queries:
   “why did semantic recall disappear when the server was swapping?”, “what did
   we decide about preserving raw chat captures?”, “where did I discuss sincerity
   and ikhlas?”, and “what is the phone and server embedding plan?”. Check paraphrase
   recall, literal anchors, inactive branches, latency, and irrelevant high ranks.
   For image/audio/video, use synthetic matched captions first, then new approved
   captured assets. Compare phone generic-build vectors on identical preprocessing;
   test the SM8550 NPU artifact separately before sharing an index.
6. After stable coverage and accepted quality, remove scrobbler's old Ollama
   dependency and stop only that service. Retain its volume through an agreed
   rollback window. Removing `nomic-embed-text`, unused `qwen3:4b`, or the roughly
   2.8 GB `/mnt/server-ssd/ollama` store is a separate destructive approval. Do not
   delete the spike cache/venv while this deployment depends on them.

Rollback: cancel the backfill, restore the previous provider/model and
`OLLAMA_BASE_URL=http://ollama:11434`, retain/restore the Ollama dependency and its
existing capped service, and recreate scrobbler. The nomic JSON/BLOB set is retained;
no vector migration backwards is required. Messages changed or captured during the
Gemma interval may need a bounded nomic backfill; until then literal search works.
Stop the unused embedder after callers switch. Keep both derived sets for review.
Rolling back the application binary to pre-BJS-548 uses retained JSON only and can
require rebuilding recent nomic rows from canonical data.

## Verification and remaining risks

Verified in disposable Daytona compute with Bun 1.3.14 and frozen dependencies:
**414 Bun tests passed, zero failures; `bun x tsc --noEmit` passed; 29 Python tests
passed**, including synthetic ffmpeg decode. No model was loaded in these tests.
The real capped partial runtime attempts and installed API audit are separate
checks. Test receipt: `services/embedder/verification/test-results-2026-10-13.json`. `scripts/verify-bjs-548.sh` reproduces the disposable test environment.

Tests cover model coexistence, legacy conversion/resume/corruption, unknown
provider dimensions, current-text ranking, query fallback, idempotency, throttling,
load/cancel/stale handling, multimodal ownership/deletion, allowed paths, bounded
HTTP/media input, single-engine serialization, unload/reload with fakes, adapter
prefixes/Unicode pooling, and the actual Bun-to-Python HTTP contract. Full-suite
ordering exposed existing extension test globals; cleanup now restores `fetch`
and the original `chrome` descriptor.

Open gates: measured unload after media and repeated idle cycles, completed native media inference,
maximum eight-frame RSS under 2 GiB, Docker image ABI execution, real-archive quality
and latency, and phone/NPU agreement. Chunk pooling quality needs archive evaluation.
Timeouts can expire while the native engine safely drains, delaying the next query.
The service limits media rather than automatically segmenting long recordings.
The venv/cache deployment remains coupled to the spike directory. Changing model
weights or preprocessing under the same model ID requires clearing/rebuilding that
specific derived set; ordinary idempotent backfill cannot detect policy changes.
