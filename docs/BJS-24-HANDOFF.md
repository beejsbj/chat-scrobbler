# BJS-24 Handoff: Hybrid Search With Real Providers

## Assessment

BJS-24 now has the real provider choice wired behind the existing hybrid seam.

Implemented:

- `chat-scrobbler search` and MCP `search` use one shared `searchMessages` path.
- Results are one combined ranked set from FTS plus the semantic index table.
- Results are deduped by `(session_id, message_id)`.
- Existing result fields are preserved, with `provenance`, `score`, and `match_sources`
  added.
- The semantic index is rebuildable under `index/`, keyed by `(session_id, message_id)`.
- `unify`, CLI `search`, stdio MCP, HTTP MCP, and `serve` all use the configured
  embedding provider.
- Cloud backend: `CHAT_SCROBBLER_EMBED_PROVIDER=gemini`, default model
  `gemini-embedding-2`.
- Local backend: `CHAT_SCROBBLER_EMBED_PROVIDER=ollama`, default model
  `mxbai-embed-large`.
- Default backend: `none`, so literal search still works without an API key or local
  embedding server.
- Test/debug backend: `hash`, deterministic and dependency-free.

## Commands

Gemini:

```bash
export CHAT_SCROBBLER_EMBED_PROVIDER=gemini
export CHAT_SCROBBLER_EMBED_MODEL=gemini-embedding-2
export GEMINI_API_KEY=...
chat-scrobbler unify
chat-scrobbler search "your conceptual query"
```

Ollama:

```bash
ollama pull mxbai-embed-large
export CHAT_SCROBBLER_EMBED_PROVIDER=ollama
export CHAT_SCROBBLER_EMBED_MODEL=mxbai-embed-large
chat-scrobbler unify
chat-scrobbler search "your conceptual query"
```

## Remaining Honest Limits

- SQLite currently stores vectors as JSON and scans them in-process. That is acceptable
  for the current personal corpus, but a true vector index is still a future
  performance upgrade.
- Recall is text-first. Attachments are only pointers/filenames today; image contents
  and file bytes are not downloaded or embedded.
- Ingest can embed immediately when a provider is configured, but provider outages will
  fail that capture path until a retry/repair queue exists. Running `unify` repairs the
  rebuildable index from canonical JSON.
