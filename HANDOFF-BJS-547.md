# BJS-547 handoff

## State

Implemented on `feat/bjs-547-asset-capture`, based on `origin/main`.
Extension version: **0.3.0 → 0.4.3** (initial 0.4.0, first review 0.4.1, round 2 0.4.2, round 3 0.4.3).
Round 3 authorizes publishing and ordinary PR merge after verification. No deployment,
production data operation or authenticated provider access was performed.

Assets are downloaded during capture, bounded while reading, hashed before upload,
and associated with message pointers in archived raw. Parsers rebuild typed media
links from those records. Failed discoveries are archived too, with null canonical
paths, so later backfill can retry them. Text capture continues after every asset failure. Environmental conversation/ingest failures stop sync for retry.

Server changes are additive. A deployed v0.3.0 extension can keep using its existing
`POST /assets`, `POST /captures`, and `POST /status` contracts. The new extension
falls back to byte upload if an older receiver lacks hash lookup. Backfill needs
this branch's receiver endpoints.

## Coverage

**Captured** below means implemented and exercised with fixtures/test doubles,
including download and parser linking. It does not mean checked against Burooj's
live account. **Unverified** identifies provider shapes/routes still requiring a
browser check. **Not available** means this implementation has no binary URL or
export-creation route to fetch. The absence of a URL is not evidence that a provider
can never expose one.

| Provider | Asset type | Coverage | Conditions / limits |
|---|---|---|---|
| ChatGPT | Uploaded images | Captured; live unverified | `sediment://`, `file-service://`, bare file IDs, image URLs |
| ChatGPT | Generated images, image_gen / DALL-E | Captured; live unverified | Tool messages, aggregate image results; signed CDN and legacy DALL-E Azure host |
| ChatGPT | Uploaded documents / files | Captured; live unverified | Metadata attachment IDs, MIME and filenames |
| ChatGPT | Interpreter files / images | Captured; endpoint unverified | Exposed generated files and `sandbox:/...` links; interpreter route is isolated behind a named function |
| ChatGPT | Voice audio | Captured; live unverified | Exposed root/nested audio pointers, including real-time user audio/video structures |
| ChatGPT | Video | Captured through pointer handling; live unverified | Only exposed video/container pointers or download URLs; no separate video inventory API |
| ChatGPT | Canvas / artifacts | Text already canonical; exposed binaries captured | No export creation request is made |
| Claude | Uploaded images / PDFs / files | Captured; live unverified | `files`, `files_v2`, attachments; exposed download/preview/document URLs preferred |
| Claude | Generated files / visuals | Captured; live unverified | Generated file descriptors, tool-result media, inline base64, exposed sandbox paths |
| Claude | Audio / video | Captured through MIME/file handling; live unverified | Only exposed binary descriptors; no new voice API assumed |
| Claude | Text artifacts | Not an asset | Existing canonical artifact text is preserved |
| Claude | Binary artifacts | Captured; live unverified | Exposed files/URLs/inline bytes represented as typed media; no sandbox inventory crawl |
| Gemini | Uploaded images | Captured; payload unverified | API upload metadata first; loaded-chat DOM fallback |
| Gemini | Voice notes / audio files | Captured; payload unverified | Audio MIME/URL descriptors in user metadata; DOM audio/source fallback, including provider-page blob URLs |
| Gemini | Uploaded video | Captured; payload unverified | Video MIME/URL descriptors; DOM video/source fallback, including provider-page blob URLs |
| Gemini | Documents / files | Captured; payload unverified | Exposed downloadable URL/file descriptors; IDs without URLs are reported unavailable |
| Gemini | Generated images / Nano Banana | Captured; payload unverified | Rich-content image slot, positional and sparse forms; DOM fallback |
| Gemini | Generated video / music | Captured; payload unverified | Rich-content video and audio/music URL slots; only already fetchable outputs |
| Gemini | Canvas / Deep Research exports | Unverified | Explicit download/export descriptors and visible download anchors on allowed media hosts are handled |
| Gemini | Export with no downloadable descriptor | Not available | No export-creation RPC, Drive/Docs export conversion, or generated-output polling implemented |

A skipped/failed discovered asset produces an `asset_capture_failed` event with
source, session, message and one of `asset_download_failed`, `asset_too_large`,
`asset_upload_failed`, `asset_url_unavailable`, or `asset_expired`. The extension
reports the failure through `/status`; provider URLs and error bodies are omitted
from logs. Extension asset counters are process-local; receiver counts now persist in the
BJS-546 monitoring state database. Backfill also shows saved and
unavailable counts in the popup.

## Endpoint verification

**VERIFIED (local)** means exercised against the real ingest handler/store with
isolated temporary data. **UNVERIFIED (live)** means no authenticated provider
browser was used in this work. Public implementation evidence informed the seams,
but does not prove they work for the current account.

| Endpoint / seam | Status | Evidence |
|---|---|---|
| Receiver `GET /assets?sha256=...` | VERIFIED (local) | Auth, existing/missing hash tests; stat-only lookup |
| Receiver `POST /assets/reference` | VERIFIED (local) | Hash alias/provenance, deletion guard, missing blob; no byte body |
| Receiver `POST /assets` | VERIFIED (local) | Streamed size bound, legacy response, blob bytes and SHA-256 |
| Receiver `GET /assets/backfill` | VERIFIED (local) | Keyset paging, missing aliases, canonical legacy sessions, tombstones |
| Receiver `POST /assets/backfill` | VERIFIED (local) | Matching pointers/messages, blob validation, raw enrichment, reparse, legacy retention |
| Receiver `POST /status` capture failure snapshots | VERIFIED (local) | Persistent list and validation; old requests remain accepted |
| ChatGPT `/backend-api/files/download/{id}?conversation_id=...&inline=false` | UNVERIFIED (live), source-supported | Modern sediment/bare-ID route; JSON `download_url` then bytes |
| ChatGPT `/backend-api/files/{id}/download` | UNVERIFIED (live), existing route | Legacy file-service route now supports JSON links |
| ChatGPT `/backend-api/conversation/{id}/attachment/{file}/download` | UNVERIFIED (live), source-supported | Sediment 404 fallback |
| ChatGPT `/backend-api/conversation/{id}/interpreter/download?message_id=...&sandbox_path=...` | UNVERIFIED (live) | Test double; `chatgptFileDownloadEndpoint` marks interpreter routing unverified |
| Claude exposed download/preview/document URLs | UNVERIFIED (live), source-supported | Prefer API URLs, including `document_asset`; no URL invented when one is exposed |
| Claude `/api/organizations/{org}/conversations/{id}/wiggle/download-file?path=...` | UNVERIFIED (live), source-supported | Exposed upload/output sandbox paths |
| Claude `/api/organizations/{org}/files/{id}/download` | UNVERIFIED (live), inherited guess | UUID-only fallback isolated as `claudeUnverifiedFileDownloadEndpoint` |
| Gemini `/_/BardChatUi/data/batchexecute`, `hNvQHb` | Existing repo verification dated 2026-06-06; not reverified here | Existing conversation fetch and auth strategy retained |
| Gemini rich-content slots 7 / 59 / 86 | UNVERIFIED against live `hNvQHb` | Based on Gemini-API candidate parsing; that implementation uses a different response context |
| Gemini direct API / DOM media URLs | UNVERIFIED (live) | Fixtures cover user audio/video/documents, generated media and API-before-DOM dedup |

Primary implementation references:

- [chatgpt-exporter API implementation](https://github.com/pionxzh/chatgpt-exporter/blob/master/src/api.ts): download-link JSON and generated media handling.
- [export-chatgpt file research](https://github.com/brianjlacy/export-chatgpt/blob/main/_docs/PROJECTS_FILES_RESEARCH.md): modern file routes and conversation context.
- [gpt2api image handling](https://github.com/69gg/gpt2api/blob/main/app/chatgpt/image.py): legacy and attachment fallback patterns.
- [ChatPeek asset policy](https://github.com/vl3c/ChatPeek/blob/master/ChatPeek.py): the exact legacy DALL-E Azure storage host.
- [Claude exporter sandbox research](https://github.com/glebmish/claude-exporter/blob/main/docs/sandbox-files.md): `wiggle/download-file` and exposed sandbox paths.
- [Claude archiver capture plan](https://github.com/timurmuh/claude-archiver/blob/main/PLAN.md): image preview URLs and document assets.
- [Gemini-API client](https://github.com/HanaokaYuzu/Gemini-API/blob/master/src/gemini_webapi/client.py) and [constants](https://github.com/HanaokaYuzu/Gemini-API/blob/master/src/gemini_webapi/constants.py): generated image/video/music slots and sparse representations.

## Backfill usage

1. Use a receiver built from this branch when you are ready to integrate it.
2. Open a logged-in tab for each provider to backfill. Keep those tabs open.
3. In the extension popup expand **receiver** and click
   **Backfill next 25 archived chats**.
4. Read the per-provider result: saved/attempted assets, unavailable count, and
   **More chats remain** or **Pass complete**. Click again to resume the next page.
   Each page scans up to 25 canonical sessions, so a page can contain no missing
   assets while still having more chats to scan. The result counts apply to the
   latest page, not the whole pass.
5. After **Pass complete**, another click begins a new pass, including unavailable
   pointers. Download attempts are paced by one second; failed URLs are reported
   and the scan continues. No unattended backfill job was scheduled.

Backfill includes pre-raw legacy sessions. It never fabricates a provider payload
for them. For sessions with raw history, successful links are saved in a new raw
version before canonical/index updates. Original provider `fetched_at` is preserved;
`asset_backfilled_at` records enrichment time. `reparse` rebuilds those links.

ChatGPT resolves archived pointers afresh. Claude refreshes conversation metadata
for current URLs and inline bytes. Gemini currently retries archived URLs; an
expired signed URL may require a new normal capture to obtain a fresh URL. Binary
outputs still rendering are not polled. HTTP 404/410 downloads report expired.
Other provider rejection statuses report download failure.

## Sync cursor and failed-chat retry

After three failures at the same provider update timestamp, the conversation is
quarantined and the cursor advances past it. Its ID, timestamp, attempt count and
quarantine state remain in extension storage and `/status`'s `capture_failures`.
The server stores snapshots beside the index, surviving server restarts.

A changed ChatGPT/Claude timestamp resets quarantine. Every provider quarantine now retries after 1, 3, then 7 days on successive
failures, while preserving its attempt history. **Retry failed chats**
in the popup retries only recorded failures, paced by one second. It does not
reset the entire provider sync cursor. Provider 429/503 conversation responses
stop sync as `RateLimitError` without counting chats toward permanent quarantine.
Gemini still fetches the payload of visible sidebar IDs because it cannot compare
timestamps, but acknowledged unchanged payloads skip asset downloads and ingest.

## What Burooj must do manually

1. Build output is ready at `packages/extension/build`. Open `chrome://extensions`,
   enable Developer mode, and load that directory as an unpacked extension, or
   reload your existing unpacked install after pointing it at this build. Confirm
   **0.4.3**. Accept the added media-host permissions if Chrome requests them.
2. Reload provider tabs so they use the new content script. Remain logged in.
   Existing provider auth stays on provider requests; ingest receives only its own
   optional bearer token. Allowlisted Google media downloads can use the browser's Google
   session; signed OpenAI/Claude CDN requests omit credentials. Every provider
   download uses the source-specific policy in **Review fixes** below.
3. Keep the existing receiver URL/token settings. Defaults bound each asset to
   **100 MiB** in both extension and receiver. Adjust **Maximum asset size (MiB)** in the
   popup and receiver `maxAssetBytes` or `CHAT_SCROBBLER_MAX_ASSET_BYTES` (bytes)
   together if needed. The lower effective limit wins. Oversize downloads report
   failures rather than uploading truncated files.
4. Use a fresh or updated test conversation with a small image/document in each
   provider. For Gemini also try a voice note/audio file and video; for ChatGPT
   try image generation and an interpreter download; for Claude try a generated
   file/visual. Click **Sync open tabs now**. The new endpoints/media shapes need
   these account-specific checks before calling live coverage verified.
5. Inspect a captured session with:

   ```sh
   bun run cli get chatgpt:CONVERSATION_ID --format json
   # Substitute claude:ID or gemini:ID for the other providers.
   ```

   Find typed media blocks with non-null `local_path` and a 64-character `sha256`.
   Check the alias file under the configured canonical assets directory and open
   an image/play a short audio/video file to confirm real bytes. Default blob root
   is `~/.local/share/chat-scrobbler/canonical/assets/sha256/`.
6. Re-sync the same bytes. In the extension service-worker network panel expect
   `GET /assets?sha256=...` followed by `POST /assets/reference`, with no second
   binary `POST /assets` to the new receiver. An already known immutable file ID or explicit hash pointer checks the receiver
   before another provider download. Sandbox paths, inline slots and ordinary URLs
   always require fresh bytes, even within one chat. Their computed hash still
   avoids uploading identical bytes. Cross-origin downloads run in the service worker;
   same-origin downloads run in the provider tab.
7. Use backfill for unchanged archived sessions; incremental sync alone will not
   revisit all old ChatGPT/Claude conversations. Read popup unavailable counts and
   provider-tab/service-worker logs for categorical failures. The receiver logs
   asset failures through `/status`; conversation failure lists can be read with
   an authenticated `POST /status` body such as
   `{"source":"chatgpt","conversations":[]}`.

## Practical limits

- No authenticated live provider validation was possible in this work. API URLs,
  obfuscated Gemini layouts, and Claude's UUID fallback can change independently
  of passing fixtures. Unknown or inaccessible descriptors stay as raw references
  and null paths where a media block can be derived.
- DOM media fallback is scoped to the loaded Gemini chat. Missing WIZ bootstrap
  data and RPC outages abort without a DOM text substitute or quarantine attempts.
  Blob backfill requires the same chat page and exact media URL to remain live.
- Asset URL hosts are restricted to provider/media domains and the exact legacy
  DALL-E Azure account. Unrecognized hosts report unavailable; Drive/Docs exports
  without an exposed downloadable media URL need separate research.
- Downloads are bounded but buffered, not streamed straight to disk. Content-origin
  transfers use 1 MiB chunks and at most two active buffers. Chrome worker restarts
  or closed tabs can interrupt a transfer; failure is reported and backfill can retry.
- A later fresh capture with a failed download can project a null media link again;
  earlier successful raw versions and blobs remain archived. Backfill/reparse does
  not automatically search every historical raw version for a matching asset.
- Backfill refreshes FTS only. Embedding implementation files were not changed;
  semantic rebuilding remains handled by the existing commands.

## Verification

Final round 3 gates passed with Bun 1.3.14 after integrating current main:

| Command | Result |
|---|---|
| `bun test` | **747 pass, 0 fail**, 2,784 assertions across 68 files |
| `bun x tsc --noEmit` | **PASS** |
| `bun run build:extension` | **PASS**, output `packages/extension/build`, manifest 0.4.3 |
| `git diff --check` | **PASS** |

The real-handler integration test passed alongside the complete suite. No live
provider test or production backfill was performed.

Tests cover streamed limits without Content-Length, provider JSON download links,
message ownership and media-only turns, failed-discovery retention, digest dedup and
older receiver fallback, raw enrichment/reparse, legacy sessions, chunk assembly,
host restrictions, durable failure records and cursor advancement. A real-handler
integration test runs ChatGPT download → upload/hash lookup → raw/canonical/blob →
second-capture dedup → reparse.

The parser, server dedup, and backfill seams were delegated to Claude Sonnet 5.5
workers; their model receipts were checked. Separate read-only standards and spec
reviews also used Sonnet 5.5. Findings were inspected and integrated, including host
restrictions, recoverable failed media references, quarantine retry and preserved
provider fetch times. No review substitutes for the manual browser checks above.

## Review fixes

The reviewed build is **0.4.3**. Reload the unpacked extension and provider tabs;
checking the version distinguishes it from both earlier builds.

### Final download allowlists

The HTTPS policy is in `providers/asset-url.ts`; the DOM-only blob permission is
in `providers/gemini-page-blob.ts`. It is applied before either page or
background asset fetches and again to download-link destinations/final response
URLs. Source is required. Provider URLs belonging to another source are rejected.
Identifiers in routes are single segments containing letters, digits, `_` or `-`.
URLs are normalized before route matching. Encoded slash/backslash/dot escapes
remaining in the path, URL credentials, non-default ports, control characters and
backslashes are rejected. Query parameters do not broaden
which path can be fetched.

| Capturing provider | Allowed URLs | Credentials |
|---|---|---|
| ChatGPT | On `https://chatgpt.com` or `https://chat.openai.com`: `/backend-api/files/download/{id}`, `/backend-api/files/{id}/download`, `/backend-api/conversation/{id}/attachment/{file}/download`, `/backend-api/conversation/{id}/interpreter/download`; `/backend-api/estuary/content` only with an `id` matching `file-...` or `file_...` | Cookies and ChatGPT bearer only for these provider download routes |
| ChatGPT | HTTPS `oaiusercontent.com` and one subdomain level, or the exact `oaidalleapiprodscus.blob.core.windows.net` account; non-root media paths excluding `/api`, `/backend-api`, `/auth`, `/accounts` prefixes | Omit cookies and provider headers |
| Claude | On `https://claude.ai`: `/api/organizations/{org}/files/{file}/download`, `/api/organizations/{org}/files/{file}/preview`, `/api/organizations/{org}/conversations/{conversation}/wiggle/download-file`, or the corresponding `chat_conversations` wiggle path | Claude cookies only; no ChatGPT bearer |
| Claude | HTTPS `claudeusercontent.com` and one subdomain level; non-root media paths excluding the API/auth prefixes above | Omit cookies and provider headers |
| Gemini | HTTPS `lh3.googleusercontent.com`, `lh4.googleusercontent.com`, `lh5.googleusercontent.com`, `lh6.googleusercontent.com`; non-root paths excluding the API/auth prefixes above | Google cookies only when capturing Gemini; no provider bearer |
| Gemini | HTTPS `rr{digits}---sn-{letters/digits/hyphens}.googlevideo.com` with exact path `/videoplayback` | Google cookies only when capturing Gemini; no provider bearer |
| Gemini DOM only | `blob:https://gemini.google.com/{UUID}` from audio/video/source elements, while the page origin is exactly `https://gemini.google.com` and pathname is `/app/{captured-id}` | Local content-script fetch with credentials omitted and no headers; never fetched in background or accepted from API payloads |

Generic relative paths, `/api/auth/session`, `/backend-api/me`, cross-provider
URLs, protocol-relative URLs, `javascript:`, `data:`, `file:` and arbitrary `blob:`
pointers are refused as downloads. Only the current-page DOM blob exception above
is allowed; `asset-url.ts` continues to reject blobs in the general policy.
Claude's explicit base64 source objects are decoded locally as inline bytes and pass the same body guards; no data URL is fetched.
Unfamiliar routes stay unavailable until separately verified. The browser manifest
still grants the media-domain permissions, while runtime policy restricts fetches
to the narrower rules above.

Requests use `redirect: "manual"`. Up to five redirects with visible Location
headers may be followed only after validating every hop against the same source
allowlist. Credentials and headers are recalculated at each hop. Protocol-relative
Locations, opaque redirects and final URLs outside that allowlist are refused.
Browsers can hide Location on a manual redirect; those responses still fail closed. JSON/HTML content types and
JSON-shaped or HTML-document bodies are refused before upload, including when
mislabeled as image/octet-stream. Only known ChatGPT download-link routes may parse
JSON indirection, with a 1 MiB metadata bound; the JSON body itself is never
uploaded. Returned download URLs must pass the policy. This intentionally excludes
JSON/HTML file exports from automatic binary capture. Non-allowlisted ChatGPT `image_url`
thumbnails remain references in raw payloads, without asset failures or derived
unavailable media blocks.

### Retry and download state

- Whole-sync environmental failures are explicitly classified: provider network or
  interrupted conversation-response reads, 429/503, receiver connection/network
  errors or interrupted acknowledgements, and receiver 5xx/429. They abort without
  adding an attempt. Auth/listing 5xx also abort because no conversation run is
  possible. Unknown/local errors default to counted per-chat failures, including
  parse errors, local TypeError/DOMException, ingest 400/413/422, and an
  isolated detail 5xx other than 503. Receiver 401/403/404/405/407/408 and all other
  non-success rejections are environmental. Three consecutive new detail 5xx
  escalate to an outage, remembering the identities for the next run. A repeated
  cohort can count and continue when other chats respond; a confirmed local
  cohort can retry behind the cursor. Different cohorts and all-detail failures
  with no prior local confirmation remain environmental. Automatic and manual runs preserve saved state on abort.
- Asset errors never fail the chat, including decoding, network, stream, lookup and
  upload failures. Each is reported, and raw text still captures. Asset 429/503
  retains RateLimitError classification across the background boundary, stops
  remaining downloads in that batch, and reports each skipped asset. Claude base64
  decoding now runs inside this boundary, rather than candidate extraction.
- After three deterministic failures, quarantine advances the cursor and schedules
  retries after 1, 3, then 7 days. Due retries run even behind the cursor. Changed
  provider timestamps reset history. Manual failures increment existing attempts
  instead of resetting them to one. Transient manual failure leaves saved state intact.
- A successful listing removes non-quarantined failures no longer listed; ignored
  IDs are removed immediately. An aborted listing does not discard saved state.
- Downloads during normal capture are paced by one second, just like backfill.
  A local cache holds up to 5,000 `(provider, pointer) → sha256` hints, restricted to
  immutable identities: ChatGPT `file-...`/`file_...` (including sediment/file-service
  schemes), Gemini `file-...`/`file_...`, Claude file UUIDs, and explicit 64-character
  lowercase SHA-256 pointers with optional `sha256:` prefix. Ordinary URLs, paths,
  sandbox links and inline slots are never read or written in this cache. Existing
  0.4.1 entries for mutable pointers are ignored. Every eligible hit
  checks the receiver's current hash lookup and creates the current session alias
  without downloading bytes. Missing/collected blobs and older servers fall back
  to download/upload. Receiver changes cannot blindly reuse a cached alias.
- Gemini stores a content hash per chat and receiver after ingest acknowledges the
  capture. Unchanged payloads skip media downloads and ingest, while sidebar
  enumeration and conversation RPC fetches still occur. Single-chat/manual retry
  capture can bypass the unchanged-payload shortcut. Failed media can still be
  retried explicitly through backfill.
- Failure snapshots include a persistent per-install UUID. Server state is keyed
  by provider and install; clearing one install leaves the others intact. Old
  `source: [records]` files migrate into a legacy install without losing records.
  `/status` with `install_id` reads that install; unscoped reads aggregate the
  records, deduplicating conversation IDs using highest attempts/quarantine state.
- Posting `/status` failure snapshots is best-effort after local sync status is
  saved. A receiver outage in that report logs a categorical event and leaves the
  saved sync success intact.

Regression probes cover all six findings, including the exact session-token upload
probe, the source/scheme/redirect matrix, mislabeled session documents, repeated
outages, orphaned/ignored failures, automatic retries behind the cursor, repeated
Gemini syncs, persistent pointer reuse, two-browser clearing, manual retry history,
web thumbnails and report failures.

### Round 2

- **N1:** Five-run permanent detail-500 probes for all three providers reach the
  next chat, quarantine only the failing chat after three attempts, and advance
  the cursor. Consecutive 5xx streaks abort as environmental outages. Tests also
  cover local TypeError/DOMException, ingest 404/413, interrupted acknowledgements,
  invalid Claude base64 preserving text, asset throttling, and manual retry state.
- **N2:** Cross-conversation sandbox reuse and same-conversation overwrites ignore
  old cached hashes, including stale 0.4.1 entries. Immutable IDs still verify the
  receiver before reuse. Changed paths require a download to establish the bytes;
  hash dedup still prevents sending bytes the receiver already owns.
- **N3:** Redirect tests cover each visible hop, source-specific credentials,
  forbidden Locations and bounded cycles. Direct ChatGPT byte responses are
  consumed once rather than requested twice. Known JSON-wrapped download routes
  remain bounded indirection only; CDN JSON cannot become a download wrapper.
  Gemini current-page DOM audio/video blobs use a separate credential-free fetch
  path and the same size and document-body guards. API-injected, foreign-origin
  and opaque blobs are rejected. Revoked blobs or blobs on closed/unloaded pages
  cannot be recovered by backfill; keep the target chat open when verifying them.

These changes are **VERIFIED with local probes/test doubles**. Provider download
endpoints and actual Chrome blob/redirect behavior remain **UNVERIFIED live**;
no provider account was accessed. Opaque redirects cannot be safely followed when
Chrome withholds Location. The final allowlists above retain the existing HTTPS
credential-exfiltration guards and add only the explicitly scoped DOM blob path.

For the manual check, confirm **0.4.3**, reload provider tabs, keep the Gemini
media chat open, then click **Sync open tabs now**. Inspect hashes/files as above.
For sandbox outputs, overwrite a path with different contents or use the same path
in two chats, capture again, and check that the resulting media hashes differ.
Read categorical asset failures for unsupported, expired or opaque redirects.

Previous round 2 gates on the complete 0.4.2 tree:

| Command | Result |
|---|---|
| `bun test` | **586 pass, 0 fail**, 2,075 assertions across 61 files |
| `bun x tsc --noEmit` | **PASS** |
| `bun run build:extension` | **PASS**, built manifest confirms **0.4.2** |
| `git diff --check` | **PASS** |

Those round 2 results preceded the round 3 merge authorization. Live endpoint
verification still requires the manual browser checks above.


### Round 3

- **Receiver configuration:** Only capture-specific 400/413/422 responses count
  toward quarantine. 401/403/404/405/407/408, 429/5xx, network failures and all
  other non-success receiver responses abort without counting an attempt.
  Auth failures name the ingest token; route failures name the URL/proxy setting.
  Malformed acknowledgements, including HTTP-200 proxy login pages, also abort
  without counting a chat attempt.
  The popup retains the last error across reopening, including periodic failures.
- **Status reporting:** Aborts preserve the existing cursor, retain earlier
  deterministic per-chat attempts without counting the environmental failure, and
  store a categorical last error per provider/install. `/status` accepts the
  additive `last_sync_error` field and returns persisted `sync_errors`. Records
  include only reason, optional HTTP status and timestamp, never response bodies,
  URLs or credentials. If a bad token or broken route also blocks `/status`, the
  error remains local and is sent with the next completed sync after access is
  repaired. Query with `install_id` for one browser or omit it to aggregate.
- **Repeated detail cohorts:** Streak state survives aborted runs, worker restarts
  and fresh adapters. Identity includes chat ID and update timestamp, rather than
  a process-local count. The reviewer's three adjacent permanent-500 probe now
  completes over four runs: one environmental abort remembers the cohort, then
  three counted runs quarantine it and reach the following healthy chat. New or
  different failing cohorts abort. When all detail requests fail and the cohort
  has never been confirmed alongside a responding chat, runs stay environmental.
  Previously confirmed local cohorts retain backoff when retrying behind the
  cursor. Saved cursors never move backwards. Manual retry uses the same policy.
- **Integration:** BJS-546 from current `main` was merged into this branch.
  Conflicts preserve both monitoring configuration and asset-size settings,
  server monitoring receipts plus asset/sync reports, and both configuration test
  suites. No embedding implementation was edited by this slice.
- **Manual verification:** Load build **0.4.3**, reload provider tabs, and use
  **Sync open tabs now**. If the receiver token or route is wrong, fix the named
  setting in the popup and sync again. There should be no new quarantined chats
  from that configuration failure; authenticated `/status` will expose the
  categorical last error after reporting becomes available. Earlier asset checks
  and final URL allowlists remain unchanged. The user's round 3 adversarial review
  verified N2/N3 and the credential boundary as safe to load in a logged-in browser;
  actual provider asset endpoint coverage remains live-unverified here.

Final 0.4.3 gates are recorded in **Verification** above.

#### Final PR review fixes

- Receiver acknowledgements require `ok: true` and `count: 1`, or `count: 0`
  with a matching deleted-conversation record. HTTP-200 JSON objects such as `{}`,
  null, arrays, false acknowledgements and inconsistent counts abort as receiver
  errors before capture counters, cursors or Gemini content hashes can advance.
- Missing Gemini WIZ data aborts as environmental, including repeated runs during
  page initialization or key rotation. The extension no longer emits the
  unsupported `dom_fallback` text payload. DOM media still supplements API capture.
- Gemini blob backfill re-reads current audio/video/source elements and verifies
  the exact pointer plus current page/chat scope. Historical API references alone
  cannot grant blob permission; closed pages, removed media and other chats fail
  closed. Blob reads still omit credentials and headers.
- Parsers resolve uploaded bytes by message identity and pointer. Repeated mutable
  paths in different messages retain their respective SHA-256 links. Only legacy
  assets without a message ID can be matched by pointer alone; missing per-message
  bytes stay null rather than borrowing another message's hash. Deduplication is
  per message when ownership is known.
- Regression probes reproduce all four GitHub review findings. The HTTPS
  allowlists and credential boundary above remain intact. Version remains 0.4.3.

#### Follow-up PR review

- Aborted sync responses retain their partial failure snapshot. Deterministic
  failures already encountered continue toward quarantine across mixed runs;
  the later receiver/network failure adds no attempt and the cursor stays put.
  Detail 5xx attempts that escalate to a provider outage are rolled back. The
  same snapshot policy covers manual retry and listing failures after captures.
- Open-tab manual, periodic and retry actions select one tab per provider,
  preferring an active tab. Several tabs cannot multiply attempts in one action.
- Receiver transport retains an independent 128 MiB minimum request limit, while
  `/assets` still enforces `maxAssetBytes`. A 17 MiB raw capture with a 1 KiB asset
  limit is archived in a real local HTTP regression; a 2 KiB asset is rejected.
- The review's suggestion to allow JSON/HTML attachments is **not adopted**:
  it conflicts with the user's explicit fail-closed credential-document guard.
  These file types remain unavailable as downloadable assets, including when
  explicitly attached. Known JSON download wrappers are bounded indirection only.

#### Restore, acknowledgement and authentication probes

- Gemini content hashes expire 24 hours after an acknowledged capture, forcing a
  periodic re-post even at the same receiver URL. With the provider tab open,
  this bounds recovery for listed chats after a restore to one day. Immediate unchanged syncs still skip
  capture and downloads. Old string-only hash entries recapture once because
  their acknowledgement age is unknown. Periodic recapture may download mutable
  media again; immutable pointers still use the receiver-verified asset cache.
- Asset POST and reference acknowledgements must report `ok: true`, the exact
  pointer/hash, a safe relative asset path, and an integer byte count. Upload
  byte counts must match the downloaded data; cached references compare lookup
  size when present. Malformed, misrouted or mismatched acknowledgements become
  asset failures, preserving text and preventing pointer-cache pollution.
- ChatGPT and Claude detail 401/403 responses re-check the existing provider
  session/organization endpoint with the same session credentials. Expired or
  changed sessions abort without an attempt. A forbidden single chat still
  counts per chat when the session/organization remains valid, preserving the
  requested default for isolated provider 4xx failures. No provider secrets are
  sent to the receiver. These checks also apply to single capture/manual retry.
- Inline base64 length is bounded before `atob` or decoded-array allocation;
  the exact decoded size is checked afterwards. Oversize or invalid inline
  assets report failures without stopping text capture.
- A complete ChatGPT/Claude listing drops unseen quarantines whose retry deadline has passed.
  Future quarantines remain until due; aborted listings retain their state.
  Deleted chats therefore stop forcing a full history scan on every sync.

#### Partial listings and multiple tabs

- Every open-tab action captures each provider once, including periodic alarms.
  The active tab is preferred so Gemini's current DOM media can supplement API
  capture. Other Gemini tabs' blobs need their own active-page capture or backfill.
  For the manual media check, activate the Gemini target chat before **Sync open
  tabs now**. For blob backfill, keep that chat as the only Gemini tab so the
  backfill action routes to its live page.
- Gemini's sidebar is a partial listing. Hidden failed chats keep their attempt
  history and due retries instead of being treated as deleted. They are excluded
  from cursor blocking until listed again; explicit ignored chats are removed.
  **Retry failed chats** can revisit stored IDs even outside the current sidebar.
- Regression probes cover multiple tabs, active-page selection, unlisted pending
  and due failures, cursor progress, and preserving attempts when a hidden chat
  returns to the sidebar. Complete-list cleanup remains for ChatGPT and Claude.
