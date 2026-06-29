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
                           |-- parser registry (chatgpt:api | claude:api | gemini:api)
                           |-- writeSession() -> canonical store (~/.local/share/chat-scrobbler/canonical/sessions/)
                           `-- indexSession() -> SQLite FTS5 + semantic index (~/.local/share/chat-scrobbler/index/sessions.db)
```

The canonical store is the source of truth. The SQLite index is a rebuildable view:
`chat-scrobbler unify` rebuilds FTS and semantic rows from scratch by re-reading every
canonical session file. Nothing important lives only in the index.

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

---

## Ingest server

`packages/ingest/src/` -- a Bun HTTP server, started by `chat-scrobbler serve`.

Endpoints:

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | /health | none | liveness check |
| POST | /captures | optional bearer | receive raw captures, parse, store, index |
| POST | /assets | optional bearer | receive provider-authenticated attachment bytes |
| POST | /status | optional bearer | return synced/stale/missing for a list of conversation ids |

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
Canonical session JSON keeps the provider `pointer` and stores this relative
`local_path` when upload succeeds. Absolute paths are not written into session JSON.

Asset capture is best-effort and local-only. The browser extension fetches provider
asset URLs in the authenticated page context, then uploads bytes to the local ingest
server. If a provider rejects or expires an asset URL, text capture continues and the
attachment block keeps `local_path: null`.

Provider limits:

- ChatGPT: maps known `file-service://...` pointers to the backend file download route
  and also accepts direct URL/path pointers.
- Claude: maps `files[]` and legacy `attachments[]` UUIDs to the organization file
  download route.
- Gemini: the verified `hNvQHb` conversation RPC remains text-first. The extension only
  uploads rendered DOM image URLs when visible; otherwise Gemini attachments stay as
  provider metadata until a stable API attachment shape is verified.

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

**Block** (union): `text`, `reasoning`, `tool_call`, `tool_result`, `artifact`,
`attachment`. Attachment blocks preserve the provider `pointer`; `local_path` is a
canonical-relative asset path when bytes were captured successfully, otherwise null.

### Fork/branch trees

Parsers emit the **full** message tree including edited-away and forked branches. Each
`Message.parent_id` points to its parent; the tree is a DAG rooted at the first message.
`Session.active_leaf_id` marks the tip of the currently selected branch.

`activePath(session)` in `src/store/sessions.ts` walks `parent_id` from the leaf to the
root and reverses the result -- that is the active conversation path. Legacy sessions
without `active_leaf_id` fall back to `messages[]` as-is.

The FTS5 index indexes **every message** across all branches (so search can reach
edited-away text). `message_count` in the sessions table and markdown rendering use the
active path only.

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

Three tables:

- `sessions` -- one row per session (id, source, source_id, title, created_at,
  updated_at, message_count). Used by `list_sessions`.
- `messages_fts` -- FTS5 virtual table, one row per message across all branches. Used
  by `search`. Columns: `text` (indexed), `message_id`, `session_id`, `role`,
  `created_at`, `source`, `title` (all `UNINDEXED`).
- `message_embeddings` -- rebuildable semantic rows keyed by `(session_id,
  message_id)`. Rows are populated only when an embedding provider is configured.
  Supported providers are Gemini (`gemini-embedding-2` by default), Ollama
  (`mxbai-embed-large` by default), and a deterministic `hash` provider reserved
  for tests/debugging.

`searchMessages` AND-joins quoted FTS5 terms (to handle arbitrary user input safely).
`searchMessagesWithEmbeddings` runs semantic lookup through the same core path, dedupes
by `(session_id, message_id)`, and fuses ranks with literal hits weighted strongly. CLI
`search` and MCP `search` both use the configured provider and return the same result
shape: the legacy fields plus `provenance`, `score`, and `match_sources`. `listSessions`
queries the `sessions` table ordered by `updated_at DESC`.

The index can be fully rebuilt from the canonical store at any time:
`chat-scrobbler unify` (or `bun run unify`) calls `indexSessionWithEmbeddings` on every
session file. With `CHAT_SCROBBLER_EMBED_PROVIDER=none` (the default), it rebuilds FTS
only.

Embedding config:

| Setting | Meaning |
|---------|---------|
| `CHAT_SCROBBLER_EMBED_PROVIDER` | `none` (default), `gemini`, `ollama`, or `hash` |
| `CHAT_SCROBBLER_EMBED_MODEL` | Provider model override; defaults to `gemini-embedding-2` or `mxbai-embed-large` |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | API key for Gemini embeddings |
| `CHAT_SCROBBLER_OLLAMA_BASE_URL` / `OLLAMA_BASE_URL` | Local Ollama URL, default `http://127.0.0.1:11434` |

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
| `ingestBaseUrl` | `http://127.0.0.1:4318` (tracks `ingestPort` unless overridden) |
| `ingestToken` | `null` (no auth) |
| `backupTargets` | `["~/.local/share/chat-scrobbler/backups"]` |

**Environment variable overrides:**

| Env var | Field |
|---------|-------|
| `CANONICAL_DIR` | `canonicalDir` |
| `INDEX_PATH` | `indexPath` |
| `PORT` | `ingestPort` |
| `MCP_HTTP_PORT` | `mcpHttpPort` |
| `INGEST_BASE_URL` | `ingestBaseUrl` |
| `INGEST_TOKEN` | `ingestToken` |
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
  config/
    <config-filename>.json  # optional, included when a config file is active
```

**Restore guard**: `restoreBackup` refuses to write into a non-empty `canonicalDir`
unless `force: true` is passed, to prevent accidental overwrites.

---

## MCP connector

`src/mcp/server.ts` + `src/mcp/http.ts`

Read-only MCP server with three tools:

| Tool | Description |
|------|-------------|
| `search` | FTS across all messages; returns snippet + session_id + message_id + metadata |
| `get_session` | Fetch a full session by `source:source_id`; JSON or rendered markdown |
| `list_sessions` | Session summaries newest-first; filterable by source / title substring |

Two transport modes:

- **stdio** (`bun run mcp`): standard MCP stdio transport for local harness integration.
- **Streamable HTTP** (`bun run mcp:http`, default port 4319): stateless -- a fresh
  `McpServer` + transport is created per request. The origin endpoint is local:
  `http://127.0.0.1:4319/mcp`.

`chat-scrobbler serve` starts both the ingest server (port 4318) and the MCP HTTP server
(port 4319) together and prints both URLs.

Client surface guidance lives in [MCP_CONNECTORS.md](MCP_CONNECTORS.md). Cloud
clients such as Claude web/mobile cannot reach the localhost URL directly and
need a publicly reachable HTTPS route with compatible authentication. Tailscale
Serve is private and does not make the endpoint reachable to cloud clients;
Tailscale Funnel is public and unsafe unless compatible auth protects the MCP
endpoint. Cloudflare Tunnel + Access is only a candidate route until live
connector compatibility is verified.

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
| `init` | Scaffold data dirs + starter config file |
| `serve` | Start ingest receiver + MCP HTTP connector together |
| `backup` | Snapshot canonical/ + config to all configured targets |
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
