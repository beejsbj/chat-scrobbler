# Local EmbeddingGemma service

One process, one lazy LiteRT-LM engine. A single request lock covers snapshots,
ffprobe/ffmpeg, engine load, every chunk and media inference, and response creation.
A disconnected caller never releases that lock while work is running. Queued
queries precede queued documents; arrival order is preserved within each class.
This does not interrupt an active request or batch. Sustained queries can delay
backfill until its 110-second queue wait expires. Health does not acquire the
engine lock and reports the number of queued requests. The server checks for idle unload every 0.5 seconds, closing the
engine after 300 seconds without work. Later requests reload it.

## HTTP contract

Canonical model ID: `litert-community/embeddinggemma-2-740m-litert-lm`. It is the
request default and the value returned by embeddings and health. Other model IDs
are rejected. Default address: `127.0.0.1:4320`.

`POST /v1/embeddings`, `Content-Type: application/json`, `Content-Length` required:

```json
{
  "model": "litert-community/embeddinggemma-2-740m-litert-lm",
  "input": "title: Chat | text: document content",
  "role": "document",
  "title": "Chat",
  "input_format": "prefixed",
  "dimensions": 768,
  "encoding_format": "float"
}
```

`input` accepts a string, a media object, or an array of either, up to eight items:

```json
{"input":{"type":"image","path":"/data/canonical/assets/example.png"},"role":"document"}
```

Media types are `image`, `audio`, and `video`. Supply exactly one `path` or `base64`
(strict base64 bytes, without a data-URL prefix). Media can also carry its own
`role`, overriding the request role. No prefix is added to media.

Raw text defaults to `role: document`, `input_format: raw`, and title `none`.
Queries receive `task: search result | query: X`; documents receive
`title: T | text: X`. Prefixed inputs must agree with their role. For documents
with a supplied title, the exact expected prefix is removed by length, preserving
literal ` | text: ` delimiters in titles and bodies. Without a title, the legacy
parser splits at the first delimiter. Every chunk gets the same prefix, once.

Text splits at substantial paragraph, sentence, or whitespace boundaries, with a
UTF-8 boundary fallback for long words or CJK. Each input returns one vector:
normalize individual chunk vectors, take their equal-weight mean, truncate to the
requested dimensions, and normalize again. Accepted dimensions: 768, 512, 256,
128. Invalid/nonfinite/zero vectors produce errors. `encoding_format: base64`
returns little-endian float32 bytes. Token-ID inputs are unsupported. The response
is an OpenAI-style `object: list` with ordered `data[index].embedding` and `model`.
`usage` is omitted because the Python embedding binding does not return token
counts; byte ceilings are not reported as tokenizer counts.

`GET /health` returns this shape without importing LiteRT or loading the model:

```json
{
  "status": "ok",
  "model": "litert-community/embeddinggemma-2-740m-litert-lm",
  "model_available": true,
  "loaded": false,
  "busy": false,
  "threads": 2,
  "vision_tokens": 140,
  "idle_seconds": 300,
  "rss_kib": 18000
}
```

RSS above is illustrative. `model_available` checks that the local model is
readable and the existing cache directory is readable/writable/searchable. It
reports filesystem readiness, not a successful native load. RSS is current
`/proc/self/status` VmRSS, and can be null on a non-Linux host.

## Resource and input limits

| Limit | Default |
| --- | --- |
| Active engine requests / waiting slots | 1 / 2 |
| Queue wait | 110 seconds; expiry 503, full queue 429 |
| HTTP connections / kernel accept backlog | 6 / 8 |
| Body / body read deadline | 8 MiB / 15 seconds |
| Batch / chunks across batch | 8 / 128 |
| Raw or prefixed text bytes per item | 64 KiB, including prefix |
| Chunk bytes including prefix / native context | 1800 UTF-8 bytes / 2048 tokens |
| Title | 256 UTF-8 bytes |
| Media file bytes | 16 MiB |
| Source width or height / source pixels | 8192 / 32 Mi pixels |
| Decoded image or video frame longest side | 768, aspect ratio preserved |
| Audio | At most 30 seconds, converted to 16 kHz mono PCM16 WAV |
| Video | At most 300 seconds, at most 4 frames |
| Decode deadline per media item | 30 seconds across probe and all conversions |
| Idle unload | 300 seconds |

Video selects up to one frame per second for short clips, capped at four, evenly
spaced from the beginning into the final tenth of the full duration. It embeds
those images together in one native call; it does not extract video audio.
The lower default trades temporal detail for more room within the unchanged
120-second adapter deadline and native watchdog. The historical four-frame
parity call took 41.9 seconds; the eight-frame decode/inference call took 91.8
seconds. These different probes inform the budget, but do not measure the new
default decoder's native latency or guarantee completion under queue contention.
Audio/video with unknown, nonfinite, or excessive duration are rejected. Audio is
also checked after conversion so misleading metadata cannot exceed the cap.

Queue wait and inference time are additive. The adapter's 120-second timeout is a
client deadline, not a guarantee that large media or queued work finishes within
it. Long docs should use the adapter's sequential chunks. Native inference is
not forcibly cancelled inside a living process. Each native load/inference has a
120-second watchdog (`EMBEDDER_INFERENCE_TIMEOUT`, at most 300 seconds), also
covering native idle and shutdown close.
Overdue work makes `/health` return 503 with `status: hung`. An independent daemon watchdog
exits the whole process with status 70, allowing Compose's restart policy to
recover without unsafe concurrent native close. This watchdog does not use the
engine lock or HTTP polling thread, so it also detects idle close freezing that
polling thread. It stays armed while server shutdown drains requests and closes
the engine, then stops and joins. An idle close exception is
contained, reported as `last_close_error: engine_close_failed`, and the next
request loads a fresh engine. Disconnects drain safely, and
may consume remaining compute. Header sockets have a 15-second inactivity timeout;
body reads have a total deadline. Connections and parser header sizes are bounded.

Path inputs are denied unless allowed roots are configured. Roots are resolved and
pinned at startup. Each path resolves symlinks and must stay beneath a root, then
is opened through no-follow directory/file descriptors and copied into a private,
bounded temporary snapshot. Replacing an allowed root with a symlink cannot widen
access. FIFOs, devices, and directories are rejected. Temporary decoded files are
removed on success and failure. ffmpeg only accepts direct local media demuxers;
playlists, indirect file lists, network protocols, and URL inputs are excluded.

## Existing runtime and exact API verification

The production image installs `litert-lm==0.18.0` and fetches the immutable model
revision `24d962e906c7d332c6428e71c9676855024569e2` during build. The generic model's
SHA-256 is `e7a8a2204b91e0f96e92960e84a09a89212e1633dcb7575a9bf3378b4df77f4c`.
The fetch verifies that hash, reuses a verified local file, and atomically installs
it at `/opt/models/embeddinggemma-2-740m.litertlm`. Serving never downloads.
Native host verification alone reuses the existing Python 3.12 venv, pinned model
snapshot and compilation cache under `/mnt/server-ssd/spikes/bjs-544`.

Run from the repo root:

```sh
/mnt/server-ssd/spikes/bjs-544/venv-a/bin/python -B -m unittest discover -s services/embedder/tests -v
python3 -B -m services.embedder.verify_api
```

The source audit reads `embedding_engine.py` and `_ffi.py`, without model or
LiteRT imports. Source SHA-256 observed on 2026-10-13:
`c299c71137bf2aa43755322f3837bf5512141b42cfce07c9f0f454376571737f`.
It verifies `EmbeddingEngine(..., vision_tokens_per_image=140)` and
`EmbeddingOptions(normalize=True, vision_tokens_per_image=140,
input_overflow_strategy=InputOverflowStrategy.ERROR)` are wired to the native
vision settings. Both are set explicitly. Text and audio CPU backends receive
`thread_count=2`, as does the vision backend argument. **Binding limitation:**
0.18.0 forwards only text/audio thread counts to native settings; there is no
vision thread setter. Exact vision worker count cannot be promised from that
argument. Deployment limits total CPU to two cores' worth. The health `threads`
field represents the configured text/audio budget, not measured process threads.
The [0.18.0 native C API](https://github.com/google-ai-edge/LiteRT-LM/blob/v0.18.0/c/embedding_engine.cc)
confirms that distinction.

The [Google model card](https://huggingface.co/google/embeddinggemma-2) specifies
text task prefixes, the unified 768-dimensional space, re-normalization after
truncation, and 16 kHz mono audio. The service uses conservative operational
bounds informed by `spikes/bjs-544/REPORT.md`; its tests are synthetic correctness
checks, not retrieval quality measurements.

## Preferred deployment: private Docker sidecar

`Dockerfile` uses Python 3.12 on Debian bookworm, installs ffmpeg and the pinned
Python runtime, and fetches verified weights during build. It has no spike or
host Python dependency. Model weights in the image are read-only. The named
`embedder-cache` volume is writable by UID/GID `1001:1001`; assets use an existing
read-only bind at `/data/canonical/assets`. Existing reused cache volumes must
already be writable by that UID. The asset bind must exist and be readable by it.

The main `docker-compose.bjslab.yml` contains the sidecar under profile
`embeddings`. Validate the opt-in plan from the repo root:

```sh
docker compose -f docker-compose.bjslab.yml --profile embeddings config --quiet
```

For Coolify, its Compose invocation must receive `COMPOSE_PROFILES=embeddings`.
An environment variable passed only into the application container does not
enable a Compose profile. Without that explicit opt-in, only scrobbler and Ollama
start. If Coolify cannot forward Compose profiles, its deployment command/config
must explicitly enable the profile before choosing the embedder provider.
`compose.embedder.yml` remains an empty compatibility overlay; it is unnecessary.

Scrobbler uses its existing `default` network plus `embeddings` (`internal: true`).
The embedder has only `embeddings`, no published ports and no proxy network.
Its healthcheck verifies status, canonical model ID and model availability without
loading the engine. Scrobbler has no dependency on the embedder, so an absent or
unhealthy opt-in sidecar does not block the existing Ollama service. The production
provider/model/URL remain Ollama, `nomic-embed-text`, `http://ollama:11434`.
`CHAT_SCROBBLER_EMBED_BASE_URL=http://embedder:4320` is always configured, so an
explicit `embed-backfill --provider embeddinggemma` can reach the opt-in sidecar.
Provider and model use `${CHAT_SCROBBLER_EMBED_PROVIDER:-ollama}` and
`${CHAT_SCROBBLER_EMBED_MODEL:-nomic-embed-text}`. A deliberate Coolify switch must
set both to `embeddinggemma` and `litert-community/embeddinggemma-2-740m-litert-lm`
and enable the Compose profile. Setting only the provider keeps the Ollama model
default, which the sidecar rejects. These edits do not change any deployed service.

Deployment regressions render the main Compose file with the profile disabled,
with it enabled, and with explicit provider/model overrides. They use synthetic
token values, never start services, and require Docker Compose. Environments
without Docker skip these rendered-plan tests; local verification must run them
with Docker Compose available.

Explicit `EMBEDDER_NETWORK_MODE=private-docker` binds `0.0.0.0` and accepts Host
`embedder`, `localhost`, or `127.0.0.1`. The default `loopback` mode binds
`127.0.0.1` and only accepts the latter two. Browser Origin requests are rejected;
no CORS or public route is provided. Treat local processes and the private caller
network as trusted, since this service has no bearer authentication.

One process avoids duplicate engines. `cpus: 2`, `mem_limit: 2g`,
`memswap_limit: 2g`, `pids_limit: 64`, `init: true`, capability drop, no-new-privileges, and
`nice -n 19` constrain
shared-host impact. Equal memory and memory-plus-swap limits disable swap for the
container. The 2 GiB cap is a hard failure boundary, not evidence that the maximum
input fits. Container OOM can terminate the process; restart is `unless-stopped`.
No persistent systemd service is supplied: host loopback is unreachable from the
production Docker bridge caller.

Config environment: `EMBEDDER_NETWORK_MODE`, `EMBEDDER_PORT`,
`EMBEDDER_IDLE_SECONDS`, `EMBEDDER_INFERENCE_TIMEOUT`, `EMBEDDER_MODEL_PATH`, `EMBEDDER_CACHE_DIR`, and
`EMBEDDER_ALLOWED_ROOTS` (colon-separated existing directories).

## RSS measurement and current verification limits

Run this finite, opt-in experiment from the repo root:

```sh
python3 -B -m services.embedder.measure
```

It checks the **one-minute** uptime load average before launching; values above 8
exit 75 with a `not_measured` JSON record. The transient user unit has
`MemoryMax=2G`, `MemorySwapMax=0`, `CPUQuota=200%`, `Nice=19`, and a 300-second
runtime limit. The child verifies effective cgroup limits before importing LiteRT.
A watchdog checks load every 0.5 seconds and exits 75 if it rises above 8, including
during native work. It uses only synthetic spike fixtures, not archive data.

JSON lines report current RSS, process peak RSS, cgroup memory, load and elapsed
time: before native import/load, after native load and text, first idle close,
immediate RSS and 1/5/15 seconds after unload, reload and text, then image, audio,
video with the default four-frame cap, a second idle unload with the same settled
samples, and final close. The first unload deliberately precedes all media work. It attempts no
trim operation that would hide allocator retention. OOM, high-load abort, timeout,
or ineffective user cgroup caps mean the experiment is incomplete.

## Round 2 default-cap verification, 2026-10-13

The focused configuration, media, service, and HTTP tests pass **36 tests, zero
failures, zero skips** in 6.972 seconds:

```sh
PYTHONPATH=services/embedder/tests python3 -B -m unittest -v test_config test_media test_service test_http
```

The new synthetic ten-second clip test first failed with eight decoded frames,
then passed with four through both the decoder and embedding API. Constructor
and environment defaults agree on four frames and the 120-second watchdog. The
native probe configuration is tested separately to retain an explicit eight-frame
budget. These checks use fake engines and synthetic media; native inference,
image builds, deployment, and production data were not part of this change.

## Historical review verification, 2026-10-13

The earlier local Python 3.12 suite passed **42 tests, zero failures, zero skips** in
6.804 seconds. Docker Compose v5.0.2 is available locally; the main deployment
plan is tested with its profile disabled, enabled, and with explicit Coolify
provider/model overrides. Native load/inference watchdog, a hung idle close in
the HTTP polling thread, watchdog lifecycle cleanup, query priority, FIFO within
a priority, queue saturation/expiry, idle close failures, and model-fetch hash
verification/cache reuse are covered. Unit tests use fake engines and synthetic
ffmpeg inputs, never the model. In environments without Docker the two rendered
Compose tests skip. See [Python receipt](verification/python-review-2026-10-13.json)
and [native API audit](verification/native-api-review-2026-10-13.json).

### Historical native parity and eight frames

The finite probe reuses the exact existing spike model revision, Python runtime,
compilation cache, synthetic fixtures, and NPZ references. No model download or
production data access occurs. Run from the repo root:

```sh
python3 -B -m services.embedder.native_check
```

It uses the same transient `MemoryMax=2G`, `MemorySwapMax=0`, `CPUQuota=200%`,
`Nice=19`, `RuntimeMaxSec=300` and effective-cap checks as `measure`. A watchdog
exits 75 if one-minute load exceeds 8. `--video-only` and `--eight-only` resume
unfinished cases without repeating completed parity calls after a guarded abort.
This historical probe explicitly sets `max_frames=8`, including `--eight-only`;
it does not use or verify the current four-frame service default. Its receipts
remain unchanged. No native inference was rerun for the default-cap change.

Each completed case ran once. Three attempts were stopped by the load guard,
then the remaining case completed in a quiet window. Text/image/audio and the
exact original four video frames match the spike's `vec_a_a_text.npz` and
`vec_a_a_media.npz`:

| Case | Seconds | Cosine vs spike | Maximum absolute vector delta |
| --- | ---: | ---: | ---: |
| Text query, including lazy load | 1.038592 | 1.0 | 0.0 |
| Image | 10.734381 | 1.0000001192092896 | 2.9802322387695312e-08 |
| Audio | 15.017243 | 1.0 | 1.1920928955078125e-07 |
| Exact four spike video frames, including lazy load | 41.906265 | 1.0000001192092896 | 0.0 |

Cosines slightly above 1 are float32 rounding. Single images/audio use the bare
native `ImageFile`/`AudioFile`, matching the spike; multiple frames use a list.
All returned vectors have 768 finite entries and unit norm within float tolerance.

The service decoded a synthetic ten-second video into **eight frames** and
completed inference in **91.826558 seconds**, including lazy load and decoding.
It ran in its own fresh process after previous aborted attempts, so this is not
a peak after a completed text/image/audio workload in the same process.

| Eight-frame observation | Exact value |
| --- | ---: |
| Baseline RSS | 16,324 KiB |
| Process peak RSS (`ru_maxrss`) | **1,486,800 KiB (1.418 GiB)** |
| RSS after inference | 1,479,648 KiB |
| Cgroup peak (`memory.peak`) | **1,134,075,904 bytes** |
| RSS immediately after native idle close | 218,848 KiB |
| RSS 15 seconds after close | 218,848 KiB |
| Retained RSS above baseline after close | 202,524 KiB |
| Transient unit runtime / CPU time | 108.604 s / 178.372 s |
| Swap / exit status | 0 bytes / 0 |

The earlier decision retained eight frames because RSS and cgroup peaks were
below the 1.8 GiB "near limit" threshold. That decision is historical; the service
now defaults to four for deadline margin. Idle close released 1,260,800 KiB
relative to the post-inference sample, while retaining memory above baseline. One clip and one
close do not establish worst-case asset memory or long-term allocator growth.
Latency is measured on a contended, page-cache-warm host, not a promise.

The systemd summary reported a 1.3M memory peak, inconsistent with recorded RSS
and cgroup samples. Use the process/cgroup measurements above; that summary is
excluded as a valid peak. The full standalone [native receipt](verification/native-review-2026-10-13.json)
contains every attempt's samples and load-guard exits. All four transient units
are inactive; no native worker remains running. The production image build and
ABI execution remain unverified. No deployment was performed.

### Historical text-unload measurements

The earlier `measurement-2026-10-13.json` and
`measurement-idle-first-2026-10-13.json` record guarded experiments preceding
these review changes. The idle-first experiment completed short text, close,
15-second settling and reload before a high-load abort during media. Its text RSS
was 351,676 KiB, settling at 203,132 KiB after close; reload plus text took
2.844790 seconds. These are historical receipts, not current deployment or
multimodal verification claims. Current image construction and Compose policy
are described above.
