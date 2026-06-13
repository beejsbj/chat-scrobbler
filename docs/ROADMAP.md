# Roadmap

## Now (v1)

chat-scrobbler is a working, self-hostable tool:

- Live capture for ChatGPT, Claude, and Gemini via a browser extension.
- Canonical JSON session store (one file per conversation, source of truth).
- SQLite FTS5 index, rebuildable at any time from canonical.
- Read-only MCP connector (`search`, `get_session`, `list_sessions`) over stdio and
  Streamable HTTP -- usable as a local harness tool or a remote custom connector.
- CLI (`search`, `get`, `list`, `unify`, `serve`, `backup`, `backups`, `restore`, `init`).
- Multi-target backup with a local snapshot dir default; SFTP/S3 target slots reserved.
- Single compiled binary (`dist/chat-scrobbler`) with the extension bundled alongside.

## Next: semantic recall as a pipeline

The plan is to add embeddings as a second rebuildable index alongside FTS, then layer
hybrid FTS + vector search into the existing `search` CLI/MCP surface. Embeddings rank
results; results themselves are always raw verbatim sessions -- no summaries or
generated artifacts. The embedding index lives in `index/`, never in `canonical/`.

This also frames a pipeline seam: chat-scrobbler should be easy to wire into external
memory systems (mem0, Zep, Letta, custom vector stores) both as a data source and as a
receiver for their recall results. The goal is that agents learn one surface --
chat-scrobbler's own CLI and MCP -- while the underlying retrieval can be swapped or
augmented. A `MemoryAdapter` interface (analogous to `BackupTarget`) could expose this
seam without hardcoding any particular system.

A related affordance is an incremental-export cursor: a way for external tools to ask
"give me everything captured since timestamp X" for continuous ingestion.

## Maybe / later

- Attachment byte resolution: map provider media URLs to local files in
  `canonical/assets/` and populate `Message.Block.attachment.local_path`.
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
