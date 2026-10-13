# BJS-545 handoff

Branch: `feat/bjs-545-typed-parts`. One PR slice; no push or deployment.

## Built

- Canonical schema version 2 adds image, audio, video, file, citation, ui_widget,
  and unknown parts. Text, reasoning, artifact, tool_call, tool_result and legacy
  attachment shapes remain loadable. The raw envelope stays version 1, so
  extension v0.3.0 needs no protocol change.
- Parsers retain opaque content instead of silently discarding it. Unknown blocks
  have the provider type, a bounded JSON fragment, and a raw version plus JSON pointer.
  Ingest and reparse pass the actual archived version into the parser.
- Tool calls retain name and family only. Tool replies keep classification labels
  plus media, citations and opaque parts. Ordinary tool prose, legacy tool_result
  payloads and unknown JSON are excluded from recall text. User-facing Canvas
  documents, code, edit replacements and comments are searchable artifacts.
- ChatGPT preserves recipient families, opaque references and disconnected mapping
  nodes. Claude preserves artifact edits and message models. Gemini keeps opaque
  positional fields and candidates with no prose, alongside verified text parsing.
- `reparse` rebuilds safely from raw and refreshes changed sessions through the
  existing async indexer. `unknown-types` provides counts for BJS-546.
- No runtime dependencies, embedding-provider changes, embedding-storage changes,
  or MCP response-shape changes. SQLite edits are limited to deletion guards and
  renderable active-message counts.

## Schema examples

Each object below is a block within `Message.blocks`. `Message.text` remains the
rendered projection. Examples illustrate the contract, not proof that a provider
currently emits that shape. Media pointers are opaque strings; a missing hash or
local path means the asset has not been resolved.

```json
{"type":"text","text":"Here is the answer."}
```

```json
{"type":"image","pointer":"file-service://image-id","filename":null,"local_path":null,"sha256":null,"mime_type":"image/png"}
```

```json
{"type":"audio","pointer":"provider-audio-id","filename":"voice.wav","local_path":null,"sha256":null,"mime_type":"audio/wav"}
```

```json
{"type":"video","pointer":"provider-video-id","filename":"overview.mp4","local_path":null,"sha256":null,"mime_type":"video/mp4"}
```

```json
{"type":"file","pointer":"file-uuid","filename":"report.pdf","local_path":null,"sha256":null,"mime_type":"application/pdf"}
```

A resolved media part instead has a 64-character SHA-256 and optionally a
canonical-relative `local_path`. Uploaded asset sidecars supply both when present.

```json
{"type":"artifact","artifact_id":"art1","kind":"text/markdown","title":"Report","version":"v2","content":"","operation":"update","previous_version":"v1","edits":[{"old_str":"Old paragraph","new_str":"New paragraph"}]}
```

Claude artifact create bodies remain searchable. Claude literal edits remain in
`edits`; the renderer includes title and `content`. A known earlier Claude artifact
with the same ID can supply omitted kind/title. If no kind is known, it stays empty.

Canvas artifact examples:

```json
{"type":"artifact","artifact_id":"create-message-id","kind":"code","language":"python","title":"Notebook","version":null,"content":"print('hello')","operation":"create"}
{"type":"artifact","artifact_id":"create-message-id","kind":"code","language":"python","title":"Notebook","version":null,"content":"print('welcome')","operation":"update","updates":[{"pattern":"print\\(.*\\)","replacement":"print('welcome')","multiple":false}]}
{"type":"artifact","artifact_id":"create-message-id","kind":"code","language":"python","title":"Notebook","version":null,"content":"Explain the greeting","operation":"comment","comments":[{"pattern":"print","comment":"Explain the greeting"}]}
```

Canvas `type: document` maps to `kind: document`, `language: null`; `code/<language>`
maps to `kind: code` plus `language`. Updates retain regex `pattern`, `replacement`
and optional `multiple` in `updates`; comments retain `pattern` and `comment` in
`comments`. Their `content` is the replacements or comments joined with single
newlines, making that prose searchable without indexing patterns or serialized JSON.
The parser does not apply edits or reconstruct the resulting whole document.

Canvas identity is local: the create message ID supplies `artifact_id`. Updates
and comments inherit it, title, kind and language from the nearest known ancestor
artifact on their branch. Without that context they use their own message ID,
null title/language and empty kind. Provider versions are not invented: `version`
remains null. These optional schema fields are additive within version 2.

```json
{"type":"tool_call","name":"canmore.update_textdoc","tool_type":"canvas"}
```

Families: `canmore`/`artifacts` to `canvas`, `image_gen`/`dalle` to `image_gen`,
`web`/`browser`/`web_search` to `browsing`, and `python` to `python`. Unfamiliar tools
keep their name and namespace as the family. There are no new `input` or `output`
fields. Labels render as `[tool: name]`.

```json
{"type":"citation","provider_type":"web_search_result_location","url":"https://example.org/reference","title":"Reference","text":"Cited passage"}
```

The decoded Claude citation shape follows the documented
[web-search citation fields](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool).
Other citation and content-reference shapes remain unknown, preserving the fragment.
Provider-specific encrypted indices and other source metadata remain in raw.

```json
{"type":"ui_widget","kind":"chart","pointer":"provider-widget-id"}
```

`ui_widget` is a schema and rendering capability. No provider adapter fabricates
this block from unverified Intelligent UI, inline visual or Canvas JSON.

```json
{"type":"reasoning","text":"Consider the alternatives.","summary":false}
```

`summary` is optional for compatibility. ChatGPT `reasoning_recap` sets it true.
A provider's short recap cannot be expanded into reasoning it did not expose.

```json
{"type":"unknown","provider_type":"intelligent_ui","raw_json":{"content_type":"intelligent_ui","layout":{"opaque":true}},"raw_ref":"chatgpt/id/timestamp-HASH.json.gz","raw_path":"/payload/mapping/node/message/content","truncated":false,"size_bytes":58}
```

`size_bytes` is the actual UTF-8 JSON byte count, not a character count. The cap is
16,384 bytes per fragment, with a 65,536-byte inline budget across each session.
Above either limit, `raw_json` becomes null and `truncated` becomes
true; the full fragment is accessible through `raw_ref` plus the RFC 6901 JSON
pointer in `raw_path`. JSON pointer escaping handles slash and tilde. The whole
raw capture remains verbatim even when the inline fragment is below the cap.
Bare parser calls without an archive context retain the old synthetic `raw/api/...`
reference; callers persisting projections must supply `{raw_ref}` as ingest does.

Historical blocks still load:

```json
{"type":"attachment","kind":"image","filename":"picture.png","pointer":"file-id","local_path":null}
{"type":"tool_call","name":"search","input":{"q":"legacy"}}
{"type":"tool_result","name":"search","output":"legacy result"}
```

Persisted legacy `Message.text` is not rewritten on load. Legacy files without raw
remain byte-for-byte untouched, including old tool-result text already stored in
those files. Excluding that historical text would need a separate migration.

## Parser coverage

**Parsed** means decoded from a verified existing shape or asset sidecar.
**Unknown** means opaque content is retained when encountered.
**Not seen** means no representative capture is in this worktree; it does not
claim the feature is absent from production. New-feature test mutations exercise
retention, not undocumented provider schemas.

| Content | ChatGPT | Claude | Gemini |
|---|---|---|---|
| Prose | Parsed: text and multimodal string parts | Parsed: text, voice-note transcript, legacy text | Parsed: verified user/candidate text slots |
| Reasoning | Parsed: thoughts and recap; unfamiliar shapes unknown | Parsed: thinking; unfamiliar shapes unknown | Not seen as a verified content shape; opaque slots unknown |
| Image | Parsed: image_asset_pointer and sidecar hash/path | Parsed: files/attachments classified by MIME | Parsed: uploaded sidecars; generated-image RPC data unknown |
| Audio | Parsed: supported audio pointers and transcription; no real audio fixture | Parsed: MIME-classified files; not seen in fixture | Parsed: MIME-classified sidecars; music RPC structure not seen/unknown |
| Video | Not seen; opaque content unknown | Parsed: MIME-classified files; not seen in fixture | Parsed: MIME-classified sidecars; Video Overview RPC structure not seen/unknown |
| File/attachment | Metadata attachments unknown, preserving provider fragment | Parsed: files[] and legacy attachments[] | Parsed: sidecars; opaque user parts unknown |
| Artifact create | Parsed: canmore.create_textdoc name/type/content; document or code + language | Parsed: artifacts input id/type/title/content/version | Not seen; opaque Canvas/report fields unknown |
| Artifact edits | Parsed: canmore.update_textdoc patterns/replacements/multiple; replacements searchable | Parsed: old_str/new_str, command, version and parent version | Not seen; opaque fields unknown |
| Artifact comments | Parsed: canmore.comment_textdoc patterns/comments; comments searchable | No verified comment shape; unknown artifact shapes retained | Not seen; opaque fields unknown |
| Tool traffic | Parsed: recipient/tool-author families, code/execution labels | Parsed: tool-use/result labels, artifact exception above | No verified tool shape; opaque fields unknown |
| Citation/reference | Unknown: metadata citations and content_references | Parsed: documented web_search_result_location; other shapes unknown | No verified shape; opaque fields unknown |
| UI widget / chart / form / map | Not seen; unrecognized content unknown | Not seen; inline-visual/doc/slide/design content unknown | Not seen; interactive-visual content unknown |
| Deep Research / generated media | Tool family classification when available; other parts unknown | No verified new shape; unknown | No verified new shape; unknown |
| Message model | Parsed: metadata.model_slug | Parsed: message.model when supplied | Parsed: response slot 21 |
| Title | Parsed: conversation title | Parsed: conversation name | Explicit envelope title supported; current fixture has none |

The production audit's numerical counts were not rechecked: production data access
was prohibited. The identified dropping behavior was verified against code and repo
fixtures. Gemini's positional fallback names such as `gemini.candidate.12` identify
an opaque slot where there is no provider type string. The review fixes below leave known metadata in raw and use stable content
categories. Reparse removes the original metadata-only blocks; the report groups
legacy positional names while older projections await reparse.

Canvas coverage uses regression probes for the requested tool argument shapes,
in code/JSON and text-part envelopes. No representative production Canvas capture
was added or accessed. Unfamiliar Canvas types, methods and malformed arguments
remain unknown rather than being guessed.

## Reparse semantics

```sh
chat-scrobbler reparse
chat-scrobbler reparse --source claude
chat-scrobbler reparse --session chatgpt:conv-1 --dry-run
chat-scrobbler reparse --source gemini --json
chat-scrobbler unknown-types --source chatgpt --json
```

- Enumerate the union of canonical session files and provider raw directories.
  Raw-only sessions can be recovered. Unknown source and unsafe session filters
  are rejected; combined filters must agree.
- Select `latest.json`'s archived version. This is arrival order, not lexical
  `fetched_at` order. A missing/invalid marker falls back to file mtime without
  repairing or writing raw metadata.
- Skip tombstones before reading or parsing. `writeSession` also enforces them.
- With no raw version, leave the canonical file and index alone.
- Verify the raw envelope identity and require exactly one matching parsed session.
  Parse failure, a corrupt raw capture, or losing all messages from an existing
  nonempty session is reported without replacing canonical. Continue other sessions.
- Preserve an existing title when raw does not supply one. Otherwise canonical is
  rebuilt from raw; arbitrary manual canonical edits are not a separate truth source.
- Compare projections, skip unchanged sessions, atomically write changed canonical,
  and call `indexSessionWithEmbeddings` for each changed session. No pruning.
  The existing indexer reuses vectors when text, title and provider identity match.
- Embedding failure leaves FTS and canonical usable, retains prior vectors under
  existing indexer rules, increments `embedding_failures`, and gives CLI exit 1.
  A canonical snapshot/tombstone guard prevents delayed vector replacement after
  concurrent ingestion or deletion changes the session.
- Canonical and SQLite are not one atomic transaction. An index failure after a
  canonical write reports `canonical_updated: true`; run `unify` to repair the
  derived index. A later reparse may see that canonical as unchanged.
- Dry-run parses and reports planned changed/unchanged/no_raw/deleted/failed counts
  and affected IDs, including `raced` skips. It creates no canonical directory, index, vectors or raw marker,
  and makes no embedding calls.
- JSON reports and errors contain IDs, statuses and categorical reasons, never raw
  fragments, provider error strings or secrets. Any session or embedding failure
  makes the CLI exit 1. Invalid arguments also exit 1.
- `unknown-types` counts all branches in nondeleted canonical sessions by provider
  and type. It reports unreadable sessions separately and excludes their partial
  counts. No unknown types is a normal empty report, not an error. Legacy Gemini
  index-suffixed categories are grouped into stable content categories.

## Decisions and remaining work

- Opaque fragments are capped at 16 KiB each and 64 KiB inline JSON per session.
  Independent parts are retained as raw pointers when either budget is exceeded.
  Block and pointer metadata is outside the inline JSON budget.
- Ordinary tool machinery stays raw. Artifact bodies and structured edits are the
  explicit semantic exception. Canvas replacement/comment prose enters recall;
  edit patterns stay structured. New tool replies keep labels and non-prose content.
- Known parts are projections, not full provider objects; additional metadata stays
  in raw. Unknown parts retain their JSON below the cap and raw pointers above it.
- No guessed structures for late-2026 visual features. Schema capacity and raw
  retention allow later adapters to rebuild from the same archive.
- **BJS-546:** baseline unknown counts, alert on changes, verify real citation/UI/
  research/visual schemas, distinguish Gemini metadata slots from new content,
  and add verified fixtures before decoding them. No alert scheduling in this slice.
- **BJS-547:** capture/fill media bytes and hashes, resolve provider pointers, capture
  sidebar titles into Gemini envelopes, verify generated-image/music/video pointers,
  and implement widget/media presentation. No media downloads in this slice.
- Artifact edit application/materialization is not implemented. Version metadata
  and edits are preserved for a future consumer.

## Verification

Baseline before edits: `bun test`, **368 pass, 0 fail**, 1,134 expectations.
The supplied three failures did not reproduce on that first run.

Pre-review `bun test`: **387 pass, 0 fail**, 1,244 expectations across 40 files,
11.46 seconds. `bun x tsc --noEmit`: **exit 0**, no diagnostics.

An intermediate full run hit four five-second timeouts, three in unchanged tests
and one in the new filesystem report test. Rerunning all 43 tests in those four
files passed in 2.52 seconds. The new filesystem/process integration tests use a
30-second budget; existing test budgets are unchanged. The final default full
suite passed without a global timeout override.

Behavior checked: typed media rendering, legacy compatibility, tool-noise exclusion,
unknown UTF-8 cap and escaped/raw-version pointers, recipient classification,
artifact edits and citations, all branches/candidates, disconnected nodes,
latest-arrival selection, raw-only recovery, read-only dry-run, no-raw retention,
tombstone skips, parse/corrupt-raw isolation, source/session filters, vector reuse,
changed-text FTS replacement, degraded embeddings, and both CLI commands.

Test temporary directories and logs were confined to this worktree with
`TMPDIR="$PWD/.tmp"`. No production archive was opened or changed.


## Review fixes

The independent review reported successful v1 loading/rendering against 5,572
production sessions, no-raw byte preservation, read-only dry-run and unchanged MCP
shape. These fixes use repo fixtures and synthetic regression probes; no production
archive was accessed by this implementation session.

### ChatGPT tool media and unfamiliar prose

- Tool-role and directed-recipient messages now run the content parser. Their
  tool label is followed by media, files, citations and unknown blocks when present.
  Text/reasoning/tool-payload blocks are filtered from those tool messages.
- Regression probes cover both tool-role `dalle.text2im` and directed assistant
  messages with an image pointer, SHA-256 and local path, plus an unfamiliar part.
- Unrecognized ordinary content such as `tether_quote` emits extracted string
  `text`/`parts` and the original unknown fragment. String parts within mixed lists
  remain searchable. Direct tool traffic still excludes that extracted prose.
- `content_type: text` string parts use single newline joins again. Existing
  multimodal block separation is retained.

### Concurrent ingest and deletion

- Reparse re-resolves the latest raw version after parsing and immediately before
  writing. A changed reference is skipped as `raced`; JSON and text summaries
  include the raced count. A raced skip alone does not make the CLI exit 1.
- Tombstones are checked before writing and before indexing. Deletion during a
  write/read failure is reported as `deleted` rather than a generic failure.
- The indexing guard compares current canonical against the exact serialization
  of the session being indexed, rather than adopting whatever file a concurrent
  writer has produced. An async stale result is classified as `raced` or `deleted`.
- Index writers accept optional `canonicalDir` and check tombstones inside the
  literal transaction and before delayed vector replacement. Ingest, unify and
  reparse all supply it. Standalone callers can supply it for the same protection.
- Deterministic regression tests simulate ingest during parsing, ingest after the
  canonical write, deletion after the canonical write, and independent index writes
  of tombstoned sessions. Canonical/raw/SQLite are still separate stores, without
  a shared cross-process transaction or lock.

### Gemini size and unknown reports

- The verified fixture now emits **zero metadata unknown blocks**, rather than 29
  across the session. User control fields, candidate status/locale/branding fields,
  and response locale/suggestion/status fields stay in raw only.
- Metadata is ignored only when its fixture-backed shape matches. New objects or
  populated positional content in a formerly empty slot still become unknown;
  the allowlist does not assume that every future value at that index is metadata.
- New fallback names are stable categories such as `gemini.candidate.content`.
  Provider type strings such as `interactive_visual` take precedence. The report
  also groups earlier `gemini.candidate.N` names into the same content category.
- All three parsers apply a **64 KiB per-session inline unknown JSON budget**,
  spanning every message and branch, in addition to the existing **16 KiB per-part
  cap**. Parts that do not fit retain `raw_ref`, `raw_path`, original `size_bytes`,
  null `raw_json` and `truncated: true`. Recognized prose and media are unaffected.
- UTF-8 regression probes add 12 independent fragments across separate messages
  for each provider and verify bounded inline bytes plus surviving raw pointers.
  This bounds opaque payload bytes, not the overhead of arbitrarily many blocks.

### Recall and fallback behavior

- `message_count` counts only active-branch messages with nonempty rendered text.
  Media and tool labels count as renderable. Opaque-only messages remain in canonical
  for preservation but do not inflate the count. FTS still indexes all branches.
  Existing index counts adopt this rule when refreshed; no data migration is needed.
- `get --text-only` excludes unknown, reasoning and tool blocks and regenerates
  `Message.text` from the retained blocks, keeping JSON and Markdown consistent.
- Claude's `m.text` fallback is restored when content has only empty text blocks.

### Review verification

- `bun test`: **401 pass, 0 fail**, 1,299 expectations across 42 files,
  13.56 seconds, using the default test command and timeout settings.
- `bun x tsc --noEmit`: **exit 0**, no diagnostics.
- Every finding has a regression test that failed before its implementation.
  The race tests inject concurrent actions at public parser/store boundaries;
  they do not depend on scheduler timing or sleeps.
- All test data and temporary output stayed inside the worktree via `TMPDIR`.
  No push, deployment, production archive reads or production data changes.

### Round 2: Claude fallback and searchable Canvas

- Claude falls back to `m.text` unless a text, reasoning or artifact block exists.
  Unknown flags, citations, media and tool labels no longer suppress that fallback.
  The regression probe retains `{type: "flag"}` alongside `hello from text field`.
- Canvas create, update and comment recipient calls now retain their tool label
  and emit artifacts as described above. Public parser and FTS tests verify
  searchable document/code content, replacements and comments, pattern exclusion,
  branch-local context, context-free edits and opaque malformed/future payloads.
- The known tool-family audit found Claude `artifacts` already emits artifacts,
  and `image_gen`/DALL-E outputs already retain media pointers, hashes and paths.
  Python/code-interpreter and browsing/search prose stays label-only. No other
  verified user-facing artifact tool shape was found in this worktree.
- The independent re-review supplied by Burooj reports zero unexplained differences
  across 5,572 production sessions before these two fixes. This session used only
  worktree tests and synthetic payloads.
- Round 2 gates: `bun test` **407 pass, 0 fail**, 1,325 expectations across 43 files,
  9.66 seconds; `bun x tsc --noEmit` **exit 0**, no diagnostics. Tests used worktree
  `TMPDIR` and the default timeout settings. Both fixes began with failing tests.
