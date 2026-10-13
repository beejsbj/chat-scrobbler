# BJS-547 handoff

## State

Implemented on `feat/bjs-547-asset-capture`, based on `origin/main`.
Extension version: **0.3.0 → 0.4.0**. Commits are local. Nothing was pushed,
deployed, or run against production data or provider accounts.

Assets are downloaded during capture, bounded while reading, hashed before upload,
and associated with message pointers in archived raw. Parsers rebuild typed media
links from those records. Failed discoveries are archived too, with null canonical
paths, so later backfill can retry them. Text capture continues after asset failures.

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
| Gemini | Voice notes / audio files | Captured; payload unverified | Audio MIME/URL descriptors in user metadata; DOM audio/source fallback |
| Gemini | Uploaded video | Captured; payload unverified | Video MIME/URL descriptors; DOM video/source fallback |
| Gemini | Documents / files | Captured; payload unverified | Exposed downloadable URL/file descriptors; IDs without URLs are reported unavailable |
| Gemini | Generated images / Nano Banana | Captured; payload unverified | Rich-content image slot, positional and sparse forms; DOM fallback |
| Gemini | Generated video / music | Captured; payload unverified | Rich-content video and audio/music URL slots; only already fetchable outputs |
| Gemini | Canvas / Deep Research exports | Unverified | Explicit download/export descriptors and visible download anchors on allowed media hosts are handled |
| Gemini | Export with no downloadable descriptor | Not available | No export-creation RPC, Drive/Docs export conversion, or generated-output polling implemented |

A skipped/failed discovered asset produces an `asset_capture_failed` event with
source, session, message and one of `asset_download_failed`, `asset_too_large`,
`asset_upload_failed`, `asset_url_unavailable`, or `asset_expired`. The extension
reports the failure through `/status`; provider URLs and error bodies are omitted
from logs. Asset failure counts are process-local. Backfill also shows saved and
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

A changed ChatGPT/Claude timestamp resets quarantine. Gemini has no sidebar update
timestamps, so its quarantine has a 24-hour retry deadline. **Retry failed chats**
in the popup retries only recorded failures, paced by one second. It does not
reset the entire provider sync cursor. Provider 429/503 conversation responses
stop sync as `RateLimitError` without counting chats toward permanent quarantine.
Gemini still rescans visible sidebar IDs because it cannot compare timestamps.

## What Burooj must do manually

1. Build output is ready at `packages/extension/build`. Open `chrome://extensions`,
   enable Developer mode, and load that directory as an unpacked extension, or
   reload your existing unpacked install after pointing it at this build. Confirm
   **0.4.0**. Accept the added media-host permissions if Chrome requests them.
2. Reload provider tabs so they use the new content script. Remain logged in.
   Existing provider auth stays on provider requests; ingest receives only its own
   optional bearer token. Google media downloads can use the browser's Google
   session; signed OpenAI/Claude CDN requests omit credentials.
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
   binary `POST /assets` to the new receiver. Provider bytes are still downloaded
   to compute their hash. Cross-origin downloads run in the service worker;
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
- DOM media fallback is scoped to the loaded Gemini chat. If the conversation RPC
  itself is unavailable, the existing `dom_fallback` payload is still ignored by
  the canonical parser: bytes/raw can be archived without a canonical media link.
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

Final gates passed on 2026-10-13 with Bun 1.3.14:

| Command | Result |
|---|---|
| `bun test` | **459 pass, 0 fail**, 1,593 assertions across 53 files |
| `bun x tsc --noEmit` | **PASS** |
| `bun run build:extension` | **PASS**, output `packages/extension/build`, manifest 0.4.0 |
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
