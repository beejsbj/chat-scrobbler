# Architecture

chat-scrobbler captures your AI chat history (ChatGPT, Claude, Gemini) through a
browser extension, stores it as canonical JSON sessions, indexes it in SQLite FTS5
plus a rebuildable semantic table, and serves it via a CLI and a read-only MCP
connector. This document is a technical tour of how those pieces fit together.

---

## Pipeline overview

```
browser extension (scrobbler)
  |-- POST /captures --> ingest server (port 4318)
                           |-- storeRawCapture() -> append-only raw/<source>/<source_id>/*.json.gz
                           |-- parser registry (chatgpt:api | claude:api | gemini:api)
                           |-- writeSession() -> canonical store (~/.local/share/chat-scrobbler/canonical/sessions/)
                           `-- indexSession() -> SQLite FTS5 + semantic index (~/.local/share/chat-scrobbler/index/sessions.db)
```

Raw captures and SHA-256 asset blobs are the source of truth. Ingest archives the
entire valid capture batch before opening the index or parsing it. Raw write
failure returns 503; parser failure leaves the raw versions intact. Canonical
sessions are projections, with `raw_ref` relative to the raw store. Legacy
canonical sessions without raw history remain usable and must be retained.

`chat-scrobbler unify` refreshes FTS and semantic rows in place from canonical
session files. Embedding failure keeps previous vectors. Raw-to-canonical `reparse` refreshes sessions from their latest archived capture,
skipping deleted sessions and retaining legacy sessions without raw.

`src/store/raw.ts` provides `storeRawCapture`, `listRawCaptures`, and
`readRawCapture`. Defaults place raw at `<data>/raw` when canonical is
`<data>/canonical/sessions`; other canonical layouts use a sibling `raw` directory.
Capture bytes are gzip-compressed without reserialization, including entries of
JSON batches. The SHA-256 covers the complete capture bytes, so only identical
captures deduplicate. Provider IDs are encoded without lossy sanitization.

---

## Extension (scrobbler)

`packages/extension/src/` -- a Chrome Manifest V3 extension.

- `content.ts` injects into chatgpt.com, claude.ai, and gemini.google.com. It detects
  the provider, starts sidebar badge reconciliation, and listens for sync requests from
  the background script.
- `background.ts` owns the alarm-driven periodic sync (default 30 minutes), handles
  manual sync requests from the popup, and POSTs captures to the ingest server.
- `providers/chatgpt.ts`, `claude.ts`, `gemini.ts` each implement `ProviderAdapter`:
  `sync()` walks the provider's conversation list via its own API, calls `emitCapture()`
  for every conversation that is new or updated since `lastSync`, and returns scan stats.
- Captures are batched as `RawCapture` objects (`packages/shared/src/raw-capture.ts`)
  and POSTed to `POST /captures`. A capture carries `source`, `capture_method: "api"`,
  `source_id`, `endpoint`, and the raw API `payload`.
- Sidebar badges (synced / stale / missing) are driven by `POST /status`, which queries
  the SQLite index for each conversation id and compares `updated_at`.
- Optional bearer auth: set `ingestToken` in the popup and `INGEST_TOKEN` env on the
  server; both sides must match.
- Assets are downloaded during capture. Provider helpers discover API media before
  Gemini's DOM fallback, resolve file pointers, and report failed downloads without
  stopping text capture for any asset failure. Asset throttling stops further downloads
  in that batch, reports skipped assets, and still captures text.
  Gemini DOM audio/video blob URLs are fetched only in the currently loaded
  provider page, without credentials or headers. API-injected blobs and background
  blob fetches are rejected. HTTPS media redirects are followed only when every
  visible Location passes the source allowlist; opaque redirects fail closed.
  Raw `assets` holds successful hashes and aliases;
  `asset_references` also retains discoveries whose bytes could not be downloaded.
- The extension hashes bytes before uploading. `GET /assets?sha256=...` and
  `POST /assets/reference` avoid sending bytes the server already owns. A persistent
  pointer-to-hash cache verifies receiver blob existence before downloading immutable
  file IDs, Claude file UUIDs, or explicit SHA-256 pointers. Paths, sandbox links,
  inline slots, and ordinary URLs are downloaded again; receiver hash lookup
  prevents duplicate uploads. Acknowledged unchanged Gemini payloads skip downloads
  and ingest. Against an older receiver, a missing lookup endpoint falls back to the original byte upload.
- The popup has a resumable asset backfill action and a separate failed-chat retry
  action. Backfill scans 25 archived sessions per provider per click, with one second
  between downloads, and reports saved and unavailable assets.
- Three deterministic failures at the same conversation update time quarantine that conversation
  and let the sync cursor advance. Failure records persist in extension storage and
  are reported through `/status`. A changed provider timestamp, manual retry, or
  backoff deadline reopens the conversation. Quarantine retries after 1, 3, then
  7 days while retaining attempt history, including for Gemini without timestamps.
  Network failures, provider 429/503, and receiver auth/config/outage errors stop
  sync without counting the environmental failure. Earlier deterministic attempts
  survive an abort; provisional detail 5xx attempts are rolled back if they escalate
  to an outage. Only receiver 400/413/422 count per capture.
  Local parse errors and isolated detail 5xx count per chat. A new three-chat 5xx
  cohort aborts but remembers its IDs and update timestamps in extension storage.
  Repeated cohorts count when other detail requests work; confirmed local cohorts
  also retry behind the cursor. Changed cohorts or all-detail failures without
  prior local confirmation remain environmental. Aborted runs preserve the cursor.
  Open-tab actions select one tab per provider, preferring an active page for DOM
  media. Last errors remain visible in the popup and per-install `/status`
  `sync_errors` reports; reports are retried after receiver access returns. Asset errors stay within the asset boundary.
  Ignored failures are removed. Complete listings remove absent retryable failures;
  Gemini retains unseen records from its partial sidebar, without holding its cursor.

---

## Ingest server

`packages/ingest/src/` -- a Bun HTTP server, started by `chat-scrobbler serve`.

Endpoints:

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | /health | none | cheap receiver liveness |
| GET | /health/deep | required bearer | write checks for index/stores and bounded embedder probe |
| GET | /status/report | required bearer | cheap cached operational state and receipt report |
| POST | /captures | optional bearer | receive raw captures, parse, store, index |
| POST | /assets | optional bearer | receive provider-authenticated attachment bytes |
| GET | /assets?sha256=... | optional bearer | cheap blob existence check |
| POST | /assets/reference | optional bearer | attach an existing hash to a session without uploading bytes |
| GET | /assets/backfill?source=...&after=...&limit=25 | optional bearer | page through canonical media that needs bytes |
| POST | /assets/backfill | optional bearer | link uploaded hashes into existing sessions and archived raw |
| POST | /status | optional bearer | conversation state, asset failure reports, and durable capture failure lists |

`pipeline.ts` (`foldCaptureIntoSpine`) is the hot path for POST /captures: it picks
the right parser from the registry, writes the canonical session file, and indexes it
immediately -- the session is queryable without a separate `unify` run.

Parse failures are logged as one structured JSON line to stderr (`event:
"capture_parse_failed"`, parser key, reason, sanitized URL).

---

## Canonical store

`src/store/sessions.ts` -- the file-system layer.

Layout under `canonicalDir` (default `~/.local/share/chat-scrobbler/canonical/sessions`):

```
canonical/
  assets/
    sha256/
      <first-two-hash-characters>/<sha256>       # shared immutable blob
      <first-two-hash-characters>/<sha256>.json  # first-seen metadata
    chatgpt/
      <source_id>/<sha256>.<ext>
    claude/
      <source_id>/<sha256>.<ext>
    gemini/
      <source_id>/<sha256>.<ext>
  sessions/
    chatgpt/
      <source_id>.json
    claude/
      <source_id>.json
    gemini/
      <source_id>.json
```

One JSON file per session, keyed by `source_id`. `writeSession` uses `INSERT OR REPLACE`
semantics at the file level: it overwrites the file on every capture, so re-capturing
the same conversation is idempotent.

Attachment assets live beside sessions under `canonical/assets`, derived from
`dirname(canonicalDir)/assets`. `POST /assets` stores bytes by content hash and returns
a canonical-relative `local_path` such as `assets/chatgpt/<source_id>/<sha>.png`.
The session paths are hard-link aliases to shared immutable blobs, preserving
existing extension responses. Metadata records MIME, byte size, original pointer
and URL, and the first session/message seen. Canonical attachment blocks keep
`pointer`, `local_path`, and an optional `sha256`; older JSON loads unchanged. Local
session deletion removes its aliases and projections while retaining raw and
shared blobs. Blob collection and full archive erasure are separate concerns.

Asset capture is best-effort and local-only. The browser extension fetches provider
asset URLs in the authenticated page context, then uploads bytes to the local ingest
server. For deterministic asset rejections or expired URLs, text capture continues
and the attachment block keeps `local_path: null`. Download, size, and upload failures
produce structured logs and reports through `/status`, with URLs and provider
error bodies omitted from logs. Asset failures preserve text; environmental
conversation/receiver errors abort sync for a later retry.
Receiver asset failure counts survive restarts in the monitoring state database. Conversation
failure snapshots are partitioned by persistent extension install ID. Legacy
unscoped requests aggregate snapshots. Lists are persisted beside the index as
`<indexPath>.capture-failures.json`. Categorical last sync errors are stored
separately in `<indexPath>.sync-errors.json`; they never count as chat attempts.

Both extension and receiver default to 100 MiB per asset, checked while reading
streams and before upload. Set the extension limit in the popup and the receiver's
`maxAssetBytes` JSON field or `CHAT_SCROBBLER_MAX_ASSET_BYTES` environment variable.
Downloads are bounded but still buffered in memory. Large page-origin assets use
1 MiB runtime-message chunks; cross-origin media can be downloaded and uploaded in
the background worker. Provider cookies and bearer headers are never sent to ingest. Asset fetches enforce
source-specific download URL and credential policies, validate every visible
redirect hop, refuse opaque redirects, and reject
JSON/HTML documents before upload. The exact policies are in the BJS-547 handoff.

Provider limits:

- ChatGPT: resolves `sediment://` and `file-service://` through JSON download-link
  routes; discovers image generation, uploads, interpreter outputs, and exposed
  audio/video pointers. Interpreter download routing still needs live verification.
- Claude: prefers exposed download, preview, and document URLs; supports inline
  base64 visuals and exposed sandbox files. A UUID-only fallback endpoint still
  needs live verification. Text artifacts remain canonical text.
- Gemini: scans upload metadata and generated image, video, and music slots in API
  payloads. Explicit download/export descriptors are eligible too. The media
  selectors need live verification against this account's `hNvQHb` response. DOM
  images, audio, video, and download anchors are a fallback for the loaded chat only.
  Missing WIZ bootstrap data aborts as environmental; no unsupported DOM text
  substitute is emitted. Blob backfill re-verifies the pointer in the current
  chat's audio/video/source elements before reading it without credentials.

See [BJS-547 handoff](../HANDOFF-BJS-547.md) for coverage, endpoint evidence and
manual browser checks. A binary that has no exposed download URL cannot be captured.

Backfill reads canonical pointers, including legacy sessions without archived raw.
Successful backfill enriches a new raw version before updating canonical links, so
`reparse` can rebuild them. It preserves the original `fetched_at` and records
`asset_backfilled_at` separately. Legacy sessions remain without invented provider
raw; `reparse` retains them. Backfill refreshes Claude conversation metadata and
resolves ChatGPT pointers; Gemini currently retries archived URLs directly. Expired
Gemini links can require a fresh conversation capture.

---

## Canonical schema

`src/schema/types.ts` -- the contract between parsers, store, index, CLI, and MCP.

**Session**

```typescript
interface Session {
  id: string;           // "source:source_id" (e.g. "claude:abc123")
  source: Source;       // "chatgpt" | "claude" | "gemini"
  source_id: string;    // provider-native conversation id
  capture_method: CaptureMethod; // "api" for live capture
  title: string | null;
  created_at: string;
  updated_at: string;
  default_model: string | null;
  account: string | null;
  messages: Message[];
  active_leaf_id?: string | null; // tip of the selected branch; see fork/branch below
  raw_ref: string;
  schema_version: number;
}
```

**Message**

```typescript
interface Message {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  created_at: string | null;
  parent_id: string | null; // forms the branch tree
  model: string | null;
  blocks: Block[];
  text: string;  // derived: renderText(blocks); parsers keep this in sync
}
```

**Block** (schema version 2 union): `text`, `reasoning`, `tool_call`, `artifact`,
`image`, `audio`, `video`, `file`, `citation`, `ui_widget`, and `unknown`, plus legacy
`tool_result` and `attachment`. New tool labels keep name/family only. Ordinary tool
payloads and unknown JSON are excluded from rendered recall text. User-facing
Claude and ChatGPT Canvas content is retained as artifacts. Canvas edit replacements
and comments are searchable; edit patterns stay structured. Unknown parts retain up
to 16 KiB of JSON per part and 64 KiB inline JSON per session, plus raw references
and JSON pointers. Known Gemini metadata stays in raw only. Version 1 files
remain loadable. See [BJS-545 handoff](../HANDOFF-BJS-545.md) for the contract.
Media blocks preserve the provider `pointer`; `local_path` is a
canonical-relative asset path when bytes were captured successfully, otherwise null.

### Fork/branch trees

Parsers emit the **full** message tree including edited-away and forked branches. Each
`Message.parent_id` points to its parent; the tree is a DAG rooted at the first message.
`Session.active_leaf_id` marks the tip of the currently selected branch.

`activePath(session)` in `src/store/sessions.ts` walks `parent_id` from the leaf to the
root and reverses the result -- that is the active conversation path. Legacy sessions
without `active_leaf_id` fall back to `messages[]` as-is.

The FTS5 index indexes **every message** across all branches (so search can reach
edited-away text). `message_count` in the sessions table counts messages on the
active path with nonempty rendered text. Markdown rendering also uses the active path. Opaque-only
messages remain archived but do not inflate the count.

---

## Parser registry

`src/parsers/registry.ts` -- the anti-corruption seam between raw API payloads and the
canonical schema.

```
"chatgpt:api" -> parseChatgpt (src/parsers/chatgpt.ts)
"claude:api"  -> parseClaude  (src/parsers/claude.ts)
"gemini:api"  -> parseGemini  (src/parsers/gemini.ts)
```

A parser is `(raw: unknown) => Session[]`. It receives the `RawCapture` as-is and
returns one or more canonical sessions. The registry key is `"${source}:${capture_method}"`.
If no parser is registered for a key, the ingest server rejects the capture with a
structured error log line and an HTTP 400 response.

---

## SQLite search index

`src/indexer/sqlite.ts`

The search tables are:

- `sessions` -- one row per session (id, source, source_id, title, created_at,
  updated_at, message_count). Used by `list_sessions`.
- `messages_fts` -- FTS5 virtual table, one row per message across all branches. Used
  by `search`. Columns: `text` (indexed), `message_id`, `session_id`, `role`,
  `created_at`, `source`, `title` (all `UNINDEXED`).
- `message_embeddings` -- rebuildable semantic rows keyed by `(session_id,
  message_id)`. Rows are populated only when an embedding provider is configured.
  Supported providers are Gemini (`gemini-embedding-2` by default), Ollama
  (`mxbai-embed-large` by default), EmbeddingGemma 2 through the
  `services/embedder/` sidecar (text plus image/audio/video assets; see
  `docs/EMBEDDINGS.md`), and a deterministic `hash` provider reserved for
  tests/debugging.

`searchMessages` AND-joins quoted FTS5 terms (to handle arbitrary user input safely).
`searchMessagesWithEmbeddings` runs semantic lookup through the same core path, dedupes
by `(session_id, message_id)`, and fuses ranks with literal hits weighted strongly. CLI
`search` and MCP `search` both use the configured provider and return the same result
shape: the legacy fields plus `provenance`, `score`, and `match_sources`. `listSessions`
queries the `sessions` table ordered by `updated_at DESC`.

`openIndex` enables WAL and a 5000 ms busy timeout for every writer. Health also
writes a single `index_health_probe` row. Literal replacement and vector replacement
use short transactions; embedding calls run outside them. Failed embedding calls
log categorical reasons and increment persistent counters when created through the configured provider factory. Preserved vectors
for changed or deleted message text are excluded from semantic results.

`searchMessagesReport` adds `semantic`, `reason`, and `embedding_failures` to the
array of hits. MCP keeps the existing text array and adds these fields plus `hits`
in `structuredContent`, including empty searches. Failed-query hits also carry
status fields. `/health/deep` tests embedding reachability with a two-second deadline;
normal provider calls have a ten-second timeout. Each health request embeds a
fixed diagnostic string, which incurs provider cost when using a paid backend.

The index can be refreshed from the canonical store at any time:
`chat-scrobbler unify` (or `bun run unify`) calls `indexSessionWithEmbeddings` on every
session file. With `CHAT_SCROBBLER_EMBED_PROVIDER=none` (the default), it rebuilds FTS
only.

Embedding config:

| Setting | Meaning |
|---------|---------|
| `CHAT_SCROBBLER_EMBED_PROVIDER` | `none` (default), `gemini`, `ollama`, `embeddinggemma`, or `hash` |
| `CHAT_SCROBBLER_EMBED_MODEL` | Provider model override; defaults to `gemini-embedding-2`, `mxbai-embed-large`, or `litert-community/embeddinggemma-2-740m-litert-lm` |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | API key for Gemini embeddings |
| `CHAT_SCROBBLER_OLLAMA_BASE_URL` / `OLLAMA_BASE_URL` | Local Ollama URL, default `http://127.0.0.1:11434` |
| `CHAT_SCROBBLER_EMBED_BASE_URL` | EmbeddingGemma sidecar URL, default `http://127.0.0.1:4320` |

---

## Config seam

`src/config.ts` -- resolution order: built-in defaults < JSON config file < environment
variables.

Config file auto-discovery order:
1. `CHAT_SCROBBLER_CONFIG` env var (explicit path)
2. `./chat-scrobbler.config.json` (project-local)
3. `~/.config/chat-scrobbler/config.json` (XDG user config)

**Defaults:**

| Field | Default |
|-------|---------|
| `canonicalDir` | `~/.local/share/chat-scrobbler/canonical/sessions` |
| `indexPath` | `~/.local/share/chat-scrobbler/index/sessions.db` |
| `ingestPort` | `4318` |
| `mcpHttpPort` | `4319` |
| `mcpAuthToken` | `null` (no MCP HTTP auth) |
| `mcpPublicBaseUrl` | `null` (no printed public connector URL) |
| `ingestBaseUrl` | `http://127.0.0.1:4318` (tracks `ingestPort` unless overridden) |
| `ingestToken` | `null` (no auth) |
| `maxAssetBytes` | `104857600` (100 MiB) |
| `backupTargets` | `["~/.local/share/chat-scrobbler/backups"]` |

**Environment variable overrides:**

| Env var | Field |
|---------|-------|
| `CANONICAL_DIR` | `canonicalDir` |
| `INDEX_PATH` | `indexPath` |
| `PORT` | `ingestPort` |
| `MCP_HTTP_PORT` | `mcpHttpPort` |
| `MCP_AUTH_TOKEN` or `CHAT_SCROBBLER_MCP_AUTH_TOKEN` | `mcpAuthToken` |
| `MCP_PUBLIC_BASE_URL` or `CHAT_SCROBBLER_MCP_PUBLIC_BASE_URL` | `mcpPublicBaseUrl` |
| `INGEST_BASE_URL` | `ingestBaseUrl` |
| `INGEST_TOKEN` | `ingestToken` |
| `CHAT_SCROBBLER_MAX_ASSET_BYTES` | `maxAssetBytes` |
| `BACKUP_TARGET` | `backupTargets` (comma-separated list) |

---

## Backup

`src/backup/` -- target-agnostic snapshot backup.

**BackupTarget interface** (`target.ts`): `putFile`, `getFile`, `listFiles`,
`listSnapshots`, `describe`. Only `LocalDirTarget` is implemented; `sftp://` and
`s3://` spec strings throw "not implemented yet".

**Multi-target fan-out**: `backup` generates one snapshot name (e.g.
`snapshot-20260612-153000`) and writes it to every entry in `backupTargets` using the
same name. `backups` and `restore` use the first entry as the primary target.

**Snapshot layout:**

```
<snapshot-name>/
  manifest.json          # created_at, session_file_count, total_bytes, canonical_dir, schema: 1
  canonical/
    chatgpt/<id>.json
    claude/<id>.json
    gemini/<id>.json
  raw/
    <source>/<encoded-source-id>/<timestamp>-<sha256>.json.gz
  config/
    <config-filename>.json  # optional, included when a config file is active
```

Raw history and asset blobs/metadata are included in snapshots; optional manifest
fields record raw counts and bytes. Old snapshots without raw remain compatible.
Raw restoration is append-only, including with `force: true`.

**Restore guard**: `restoreBackup` refuses to write into a non-empty `canonicalDir`
unless `force: true` is passed, to prevent accidental overwrites.

---

## MCP connector

`src/mcp/server.ts` + `src/mcp/http.ts`

Read-only MCP server with four tools:

| Tool | Description |
|------|-------------|
| `search` | FTS across all messages; returns snippet + session_id + message_id + metadata |
| `get_session` | Fetch a full session by `source:source_id`; JSON or rendered markdown |
| `list_sessions` | Session summaries newest-first; filterable by source / title substring |
| `get_asset` | Return an image or file a session references, by session id + sha256 (or `assets/...` path). Images as MCP image content, text as text, others as an embedded resource; 5 MB inline cap (`src/mcp/get-asset.ts`) |

Two transport modes:

- **stdio** (`bun run mcp`): standard MCP stdio transport for local harness integration.
- **Streamable HTTP** (`bun run mcp:http`, default port 4319): stateless -- a fresh
  `McpServer` + transport is created per request. The origin endpoint is local:
  `http://127.0.0.1:4319/mcp`.

`chat-scrobbler serve` starts both the ingest server (port 4318) and the MCP HTTP server
(port 4319) together and prints both URLs.

Client surface guidance lives in [MCP_CONNECTORS.md](MCP_CONNECTORS.md). Cloud
clients such as Claude web/mobile cannot reach the localhost URL directly and
need a publicly reachable HTTPS route with compatible authentication. When
`mcpAuthToken` is configured, `/mcp/<token>` and `Authorization: Bearer <token>`
are accepted, while anonymous `/mcp` is rejected. `mcpPublicBaseUrl` only affects
printed CLI guidance; the HTTP server still binds to `127.0.0.1`. This is a
read-only, personal/ephemeral connector mode unless a stronger OAuth/Access
layer sits in front of it.

---

## CLI

`src/cli/chat-scrobbler.ts` + `src/cli/commands.ts`

The CLI is a thin frontend over the same core functions the MCP uses. Commands:

| Command | What it does |
|---------|-------------|
| `search <query>` | Hybrid search when embeddings are enabled, otherwise FTS; `--source`, `--limit`, `--json` |
| `get <id>` | Fetch session by id (`source:source_id`); `--format json|markdown` |
| `list` | List sessions; `--source`, `--title`, `--limit`, `--json` |
| `unify` | Rebuild SQLite index from canonical store |
| `reparse` | Rebuild from latest raw; `--source`, `--session`, `--dry-run`, `--json` |
| `unknown-types` | Count opaque content by provider/type; `--source`, `--json` |
| `monitor` | Quiet cron checks from local stores; `--ack` acknowledges current unknown types |
| `init` | Scaffold data dirs + starter config file |
| `serve` | Start ingest receiver + MCP HTTP connector together |
| `backup` | Snapshot raw, canonical/assets, sessions, and config to all configured targets |
| `backups` | List snapshots in the primary target |
| `restore <snapshot>` | Restore a snapshot; `--force` to allow non-empty dest |

---

## Single-binary build

`scripts/build-dist.ts` (run via `bun run build:dist`):

1. Compiles `src/cli/chat-scrobbler.ts` into a self-contained native binary using
   `bun build --compile`. Output: `dist/chat-scrobbler`.
2. Builds the browser extension (`packages/extension/scripts/build.ts`) and copies the
   result to `dist/extension/`.

The extension ships alongside the binary so `chat-scrobbler init` can print the exact
path to load as an unpacked extension in Chrome.

---

## Operations: monitoring

The Cockpit wrapper should run this exact command **inside the container**:

```sh
/usr/local/bin/chat-scrobbler monitor
```

Run exec as the container user (`scrobbler`), never with `-u root`. State creation
refuses an effective UID that differs from the data directory owner. Existing
state files and SQLite sidecars must have that same owner.

For the checked-in Compose service, the host invocation is:

```sh
docker compose -f docker-compose.bjslab.yml exec -T scrobbler /usr/local/bin/chat-scrobbler monitor
```

The CLI exits 0, prints nothing when healthy, and otherwise prints sorted,
timestamp-free `FAILED <check> <detail>` lines. It reads local raw, canonical and
index stores without contacting the ingest server, so it works while that server
is down. It checks directory permissions with access checks, opens the index and
existing monitoring state read-only, and uses a real embedding probe with a
ten-second deadline (reported as `slow` after two seconds). Ordinary monitoring
creates no state or store directories; `--ack` intentionally writes acknowledgement state. It leaves a missing index
missing. Paid embedding providers incur a diagnostic request per CLI invocation.
Cockpit delivery and the Hermes schedule are supplied separately.

`GET /status/report` requires a configured `INGEST_TOKEN` and its matching bearer
header, even on localhost. Authenticated reports return HTTP 200 with `ok` and
`failures`; callers inspect the body. Reports coalesce concurrent requests and
cache results for 60 seconds. The HTTP scope is `live`: persisted counters,
receipts, successful parse times, unresolved recent parser failures and state
health, with indexed session dates as a bootstrap fallback. `deferred_checks`
names the archive, vector, asset and provider checks performed only by the CLI.
HTTP performs no archive scan or embedding call. No titles, chat text, provider URLs, credentials or raw fragments
are included. The CLI replaces unknown type names with opaque type IDs.

| JSON config key | Environment override | Default |
|-----------------|----------------------|---------|
| `monitorStaleDays.chatgpt` | `CHAT_SCROBBLER_MONITOR_STALE_DAYS_CHATGPT` | 7 days |
| `monitorStaleDays.claude` | `CHAT_SCROBBLER_MONITOR_STALE_DAYS_CLAUDE` | 7 days |
| `monitorStaleDays.gemini` | `CHAT_SCROBBLER_MONITOR_STALE_DAYS_GEMINI` | 7 days |
| `monitorCoverageThreshold` | `CHAT_SCROBBLER_MONITOR_COVERAGE_THRESHOLD` | 0.95 |
| `monitorRecentHours` | `CHAT_SCROBBLER_MONITOR_RECENT_HOURS` | 48 hours |
| `monitorStatePath` | `CHAT_SCROBBLER_MONITOR_STATE_PATH` | `<indexPath>.monitor.sqlite` |

Freshness prefers capture receipt times and archived `fetched_at`. Without those,
the CLI falls back to the newest canonical `updated_at` per provider; HTTP uses
the same metadata projected into the index, with a small read-only aggregate.
Last successful parse times also fall back to canonical dates until recorded.
These bootstrap dates show conversation activity, not proof of a recent browser
poll. An unused provider can have JSON `null` or env `off` for its staleness
setting. Providers with no history alert until the next sync or that override.
Invalid threshold values fall back to defaults. Provider overrides merge with the
other providers' defaults. The bjslab Compose service defaults to ChatGPT 7 days,
Claude 14 days and Gemini 21 days. Set the corresponding environment variables
on the host to tune these Compose overrides.

Coverage counts nonempty indexed messages across all branches, requiring valid
vectors for current text, title, provider, model and dimension. The recent window
uses message timestamps; messages without timestamps remain in total coverage.
Low recent coverage alerts. No usable vectors for a nonempty index, an unreachable
embedder, and explicitly disabled embeddings also alert. An empty recent window
has coverage 1, but does not hide a dead semantic leg.

The recent window also covers upload failure reports and missing attachment
blocks. Attachment recency uses session `updated_at` or the latest message time;
unify/reparse file rewrites do not make old attachments recent. Upload failures
use hourly buckets, so they can remain recent for up to one extra hour. Lifetime
totals persist without causing permanent upload alerts. Orphaned raw versions are parsed read-only to distinguish
parse failures from successful captures missing their canonical projection;
versions with a canonical session and tombstoned sessions are excluded from that
legacy orphan check. Actual ingest parser outcomes also persist provider failure
totals and recent unresolved session IDs, so an existing canonical session cannot
hide a new format failure. Empty parser results count as failures. Successful
retries clear that session's unresolved failure, retaining the lifetime count.
`freshness.parsed.<provider>` checks successful parse timestamps separately from
receipts. Canonical/index write errors do not increment parser failure totals.
Recent failure IDs in the report are opaque hashes, limited to 20 per provider;
the recent counts include all unresolved failures in the configured window.

Inspect unknown tags locally with `chat-scrobbler unknown-types`, then acknowledge
all currently seen provider/type pairs with:

```sh
/usr/local/bin/chat-scrobbler monitor --ack
```

Acknowledgement survives restarts and suppresses only those types. New types still
alert; all other checks still run. The CLI computes a fresh report after acknowledgement. The state database contains counters, hourly upload buckets, receipt
times and opaque type IDs only. Keep it when replacing the index directory; it is
separate from rebuildable index tables and is not included in current backups.
Sanitized parser contracts and instructions for adding captures live in
[`test/fixtures/contract/`](../test/fixtures/contract/README.md).
