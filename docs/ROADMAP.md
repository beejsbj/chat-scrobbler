# Roadmap

## Now (v1)

chat-scrobbler is a working, self-hostable tool:

- Live capture for ChatGPT, Claude, and Gemini via a browser extension.
- Canonical JSON session store (one file per conversation, source of truth).
- SQLite FTS5 index, rebuildable at any time from canonical.
- Read-only MCP connector (`search`, `get_session`, `list_sessions`) over stdio and
  Streamable HTTP -- usable as a local harness tool, with remote connector use
  requiring public HTTPS and compatible auth.
- CLI (`search`, `get`, `list`, `unify`, `serve`, `backup`, `backups`, `restore`, `init`).
- Multi-target backup with a local snapshot dir default; SFTP/S3 target slots reserved.
- Single compiled binary (`dist/chat-scrobbler`) with the extension bundled alongside.

## Now: semantic recall layer 1

Layer 1 adds embeddings as a second rebuildable index alongside FTS, then layers hybrid
FTS + semantic search into the existing `search` CLI/MCP surface. Embeddings rank
results; results themselves are always raw verbatim sessions -- no summaries or
generated artifacts. The embedding index lives in `index/`, never in `canonical/`.

Current backend note: real providers are configurable without changing the recall
surface. `gemini` uses `gemini-embedding-2` by default for cloud embeddings; `ollama`
uses `mxbai-embed-large` by default for local embeddings; `none` keeps literal-only
search. The deterministic `hash` provider remains only as a test/debug backend.
Embeddings are stored in SQLite JSON rows under `index/` for now; a vector extension or
external vector store can replace that implementation later if corpus size demands it.

This also frames a pipeline seam: chat-scrobbler should be easy to wire into external
memory systems (mem0, Zep, Letta, custom vector stores) both as a data source and as a
receiver for their recall results. The goal is that agents learn one surface --
chat-scrobbler's own CLI and MCP -- while the underlying retrieval can be swapped or
augmented. A `MemoryAdapter` interface (analogous to `BackupTarget`) could expose this
seam without hardcoding any particular system.

A related affordance is an incremental-export cursor: a way for external tools to ask
"give me everything captured since timestamp X" for continuous ingestion.

## Maybe / later

- Attachment byte resolution and multimodal recall: map provider media URLs to local
  files in `canonical/assets/`, populate `Message.Block.attachment.local_path`, and
  decide whether image/file embeddings belong in chat-scrobbler or a downstream wiki
  engine.
- More providers: Perplexity, Mistral, or others with accessible APIs.
- SFTP and S3 backup targets (the interface and `resolveTarget` already reserve these).
- Chrome Web Store packaging and update infrastructure.
- Sidebar badge support and/or auto-sync for additional providers.
- Content-based deduplication for conversations that arrive under different
  source ids (e.g. the same chat imported from a provider export and captured live).

## Non-goals

- No clustering, summarization, entity graphs, or knowledge-graph artifacts generated
  and served from this repo. Retrieval yes; representation no.
- No cloud service. The ingest server and MCP connector are local by default.
- Your data never leaves your machine unless you configure a remote backup target.
