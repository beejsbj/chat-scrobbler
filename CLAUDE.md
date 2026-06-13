# CLAUDE.md

chat-scrobbler captures AI chat history (ChatGPT, Claude, Gemini) via a browser
extension, stores canonical JSON sessions, indexes them in SQLite FTS5, and serves
them through a CLI and a read-only MCP connector.

## Layout

| Path | What it is |
|------|-----------|
| `src/schema/types.ts` | Canonical `Session` / `Message` / `Block` types -- the contract |
| `src/config.ts` | Config seam: defaults < JSON config file < env vars |
| `src/parsers/registry.ts` | Parser registry (`chatgpt:api`, `claude:api`, `gemini:api`) |
| `src/parsers/chatgpt.ts`, `claude.ts`, `gemini.ts` | Provider parsers |
| `src/parsers/render.ts` | `renderText(blocks)` -- derives `Message.text` |
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

## Commands

```sh
bun install
bun test
bun x tsc --noEmit

bun run cli <command>        # run CLI from source (search/get/list/unify/init/serve/mcp/connect/backup/backups/restore)
bun run serve                # ingest receiver (port 4318) + MCP HTTP (port 4319) together
bun run unify                # rebuild SQLite index from canonical
bun run build:dist           # compile dist/chat-scrobbler binary + bundle dist/extension/
bun run release vX.Y.Z       # cross-compile binaries + zip extension + gh release create
bun run mcp                  # read-only MCP over stdio
bun run mcp:http             # read-only MCP over HTTP at /mcp (env MCP_HTTP_PORT, default 4319)
```

Config resolution: defaults < JSON config file (`CHAT_SCROBBLER_CONFIG`,
`./chat-scrobbler.config.json`, or `~/.config/chat-scrobbler/config.json`) < env
(`CANONICAL_DIR`, `INDEX_PATH`, `PORT`, `MCP_HTTP_PORT`, `INGEST_BASE_URL`,
`INGEST_TOKEN`, `BACKUP_TARGET`).

## Conventions

- Bun + TypeScript everywhere. No extra package managers.
- TDD: write a failing test first, then implement, then commit.
- Keep files small and single-purpose.
- No em dashes in prose.
- `canonical/` is the source of truth; the SQLite index is a rebuildable view.
- User data lives in `~/.local/share/chat-scrobbler/` by default, never inside the
  repo. `canonical/`, `index/`, `backups/`, and `dist/` are gitignored.
