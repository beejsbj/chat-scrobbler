# BJS-24 Handoff: Hybrid Search vs Semantic Recall Quality

## Assessment

BJS-24 should stay open.

The current implementation adds the right hybrid search/index seam:

- `chat-scrobbler search` and MCP `search` use one shared `searchMessages` path.
- Results are one combined ranked set from FTS plus the semantic index table.
- Results are deduped by `(session_id, message_id)`.
- Existing result fields are preserved, with `provenance`, `score`, and `match_sources`
  added.
- The semantic index is rebuildable under `index/`, keyed by `(session_id, message_id)`.
- `unify` rebuilds the semantic rows from canonical sessions.
- Ingest keeps immediate FTS availability and avoids cloud/model/service work.

But the default `HashEmbeddingProvider` is not genuine semantic recall. It is a
deterministic, dependency-free lexical vector scaffold behind the `EmbeddingProvider`
seam. It proves the shape of hybrid search, ranking fusion, rebuildability, and shared
CLI/MCP behavior, but it will not reliably retrieve conceptually related text that uses
different language.

Given the stop gates for this slice, I do not see a responsible bounded local-only real
semantic backend to add without one of the forbidden moves: model download, native vector
extension, cloud API, or long-running local embedding service. So the honest finish-line
status is:

**Implemented:** hybrid search/index seam.

**Not Done:** semantic recall quality.

## Recommendation

Do not mark BJS-24 Done yet. Keep it open or split out a follow-up that explicitly
chooses the local embedding backend and packaging tradeoffs.

## Smallest Follow-Up Issue

Title: Choose and wire a real local embedding backend for chat-scrobbler search

Body:

Replace the deterministic `HashEmbeddingProvider` scaffold with a real local semantic
embedding backend behind the existing `EmbeddingProvider` seam.

Requirements:

- Keep canonical sessions as the source of truth.
- Keep embeddings rebuildable under `index/`, keyed by `(session_id, message_id)`.
- Keep `chat-scrobbler search` and MCP `search` as the only recall surface.
- Preserve the current shared result shape, including `provenance`, `score`, and
  `match_sources`.
- Decide explicitly whether the backend may use a model download, native vector
  extension, bundled model artifact, optional install extra, or external local service.
- Document packaging impact: binary size, first-run setup, CPU/GPU needs, offline
  behavior, and rebuild performance.
- Add at least one test or fixture that demonstrates conceptual recall across different
  wording, not just token overlap.

Suggested implementation path:

Start with an optional local embedding provider and a rebuild path in `unify`, then keep
ingest FTS-first. If the provider is slow or unavailable during capture, index FTS
immediately and let semantic rows be repaired by `unify` or a dedicated rebuild command.
