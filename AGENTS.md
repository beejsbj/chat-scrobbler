# AGENTS.md

Shared guide for any coding agent working in this repo. `CLAUDE.md` is a symlink
to this file, so both surfaces read the same instructions.

chat-scrobbler captures AI chat history (ChatGPT, Claude, Gemini) via a browser
extension, preserves raw captures and asset blobs, derives canonical JSON sessions,
indexes them in SQLite FTS5, and serves
them through a CLI and a read-only MCP connector.

## Layout

| Path | What it is |
|------|-----------|
| `src/schema/types.ts` | Canonical `Session` / `Message` / `Block` types -- the contract |
| `src/config.ts` | Config seam: defaults < JSON config file < env vars |
| `src/parsers/registry.ts` | Parser registry (`chatgpt:api`, `claude:api`, `gemini:api`) |
| `src/parsers/chatgpt.ts`, `claude.ts`, `gemini.ts` | Provider parsers |
| `src/parsers/render.ts` | `renderText(blocks)` -- derives `Message.text` |
| `src/store/raw.ts` | Append-only gzip captures; list/read versions for future reparse |
| `src/store/asset-reference-store.ts` | Write-time ownership records for bounded blob cleanup |
| `src/store/assets.ts` | SHA-256 blobs, provenance metadata, compatible session aliases |
| `src/store/delete.ts`, `tombstones.ts` | Archive deletion, private blob cleanup, resurrection guards |
| `src/store/sessions.ts` | File I/O for canonical sessions; `activePath()` |
| `src/indexer/sqlite.ts` | FTS5 build, `searchMessages`, `listSessions` |
| `src/mcp/server.ts` | Read-only MCP tools (`search`, `get_session`, `list_sessions`) |
| `src/mcp/http.ts` | Streamable-HTTP transport for the MCP (stateless, per-request) |
| `src/backup/target.ts` | `BackupTarget` interface + `resolveTarget` |
| `src/backup/backup.ts` | `createBackup`, `listBackups`, `restoreBackup` |
| `src/cli/chat-scrobbler.ts` | CLI entrypoint |
| `src/cli/commands.ts` | Command implementations (thin frontends over core fns) |
| `src/cli/unify.ts` | Rebuild index from canonical |
| `src/core/session-id.ts` | `parseSessionId` -- validates `source:source_id` format |
| `packages/extension/src/` | Browser extension (background, content, providers, popup) |
| `packages/ingest/src/` | Ingest server (POST /captures, POST /status, GET /health) |
| `packages/shared/src/` | Shared constants and `RawCapture` schema |
| `scripts/build-dist.ts` | Compiles `dist/chat-scrobbler` + bundles `dist/extension/` |
| `scripts/release.ts` | Release assets; `--build-only` / `--publish-only` split for CI |
| `.github/workflows/` | `ci.yml` (typecheck + tests on PRs and main), `release.yml` (v* tags) |

## Commands

```sh
bun install
bun test
bun x tsc --noEmit

bun run cli <command>        # run CLI from source (search/get/list/unify/init/doctor/serve/mcp/connect/backup/backups/restore)
bun run cli doctor           # verify install chain: config, tokens, ingest, MCP, embeddings, index, public URL
bun run serve                # ingest receiver (port 4318) + MCP HTTP (port 4319) together
bun run unify                # rebuild SQLite index from canonical
bun run build:dist           # compile dist/chat-scrobbler binary + bundle dist/extension/
bun run release vX.Y.Z       # local fallback: cross-compile, zip extension, gh release create
git tag vX.Y.Z && git push origin vX.Y.Z   # preferred: CI tests, builds, smoke-tests each binary, publishes
bun run mcp                  # read-only MCP over stdio
bun run mcp:http             # read-only MCP over HTTP at /mcp (env MCP_HTTP_PORT, default 4319)
```

Config resolution: defaults < JSON config file (`CHAT_SCROBBLER_CONFIG`,
`./chat-scrobbler.config.json`, or `~/.config/chat-scrobbler/config.json`) < env
(`CANONICAL_DIR`, `INDEX_PATH`, `PORT`, `MCP_HTTP_PORT`, `INGEST_BASE_URL`,
`INGEST_TOKEN`, `BACKUP_TARGET`, `BIND_HOST`).

## Conventions

- Bun + TypeScript everywhere. No extra package managers.
- TDD: write a failing test first, then implement, then commit.
- Keep files small and single-purpose.
- No em dashes in prose.
- Raw captures and content-addressed assets are the source of truth. Persist raw
  before parsing; canonical JSON, FTS, and embeddings are derived. Retain legacy
  canonical sessions that have no archived raw capture. Explicit session deletion
  erases archived data and writes a minimal tombstone; reparse must respect it.
- User data lives in `~/.local/share/chat-scrobbler/` by default, never inside the
  repo. `raw/`, `canonical/`, `index/`, `backups/`, and `dist/` are gitignored.
