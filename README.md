# chat-scrobbler

I have years of thinking spread across ChatGPT, Claude, and Gemini, and none of
it was mine. It lived in three silos, searchable only one app at a time, gone
if an account ever went away. So I built a scrobbler for it, in the last.fm
sense: every conversation I have with an AI gets quietly captured, as it
happens, into a local store I own.

This repo is that system. I am sharing it because I like the idea and want it
to exist in the world. If you build your own version instead of using mine,
that is a fine outcome too.

## What it does

- **Captures live.** A browser extension watches ChatGPT, Claude, and Gemini,
  pulls each conversation through the provider's own API, and posts it to a
  small local server. Sync badges in the chat sidebar show what is captured.
- **Stores forever.** Every conversation becomes one canonical JSON file with
  a shared schema across providers, including the full fork tree (edited and
  abandoned branches included), not just the visible path.
- **Searches everything.** A SQLite FTS5 index covers every message in every
  branch. One query, all providers, all history.
- **Answers agents.** A read-only MCP server exposes search/get/list, so any
  MCP client (claude.ai, agent harnesses, your own scripts) can recall your
  history. "When did I talk about rain gutters, and in which app?" is now a
  query.
- **Backs up.** Snapshots fan out to multiple targets with one command.

## How it does it

```
browser extension  ->  ingest server  ->  canonical JSON store  ->  SQLite FTS index
   (scrobbler)         (localhost)        (source of truth)        (rebuildable view)
```

The canonical store is the only thing that matters; the index is a disposable
view rebuilt with one command. Each provider gets a parser that maps its wire
format into the shared session schema, so adding a provider means adding a
parser, nothing else changes. Details in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## How you might use it

Install the binary (macOS and Linux). Read the script first if you like; piping
a URL to a shell deserves a glance.

```bash
curl -fsSL https://raw.githubusercontent.com/beejsbj/chat-scrobbler/main/install.sh | sh
```

That drops `chat-scrobbler` into `~/.local/bin` and the browser extension into
`~/.local/share/chat-scrobbler/extension`. Then:

```bash
chat-scrobbler init      # scaffold the data dirs + a starter config
chat-scrobbler serve     # start the capture receiver + MCP endpoint
chat-scrobbler connect   # print the MCP URL + how to wire it into Claude
```

Load the extension once: `chrome://extensions` -> Developer mode -> Load
unpacked -> pick the dir `init` printed. Paste the receiver URL from `serve`
into the extension popup. Open ChatGPT, Claude, or Gemini and watch the badges
fill in.

Then it is just a CLI:

```bash
chat-scrobbler search "that idea about water filters"
chat-scrobbler get chatgpt:<id> --markdown
chat-scrobbler backup
```

The MCP server exposes the same search/get/list over a read-only connector, so
any MCP client gets exactly what the CLI gets. `chat-scrobbler connect` prints
a ready-to-paste Claude Desktop config and the local endpoint URL.

<details>
<summary>Build from source instead</summary>

You need [Bun](https://bun.sh) and a Chromium browser.

```bash
git clone https://github.com/beejsbj/chat-scrobbler && cd chat-scrobbler
bun install
bun run build:dist          # compiles dist/chat-scrobbler + dist/extension/
./dist/chat-scrobbler init
```
</details>

## How I am using it

- `serve` runs as a launchd agent on my Mac so capture survives reboots and
  crashes ([docs/examples/com.chat-scrobbler.serve.plist](docs/examples/com.chat-scrobbler.serve.plist)).
- Backups fan out to a local snapshot dir, with a second machine next on the
  list. `backupTargets` in the config is just an array.
- The MCP endpoint is wired into claude.ai as a custom connector (via a
  tunnel), so mid-conversation I can ask "have I talked about this before?"
  and get my own history back, with sources.
- Longer term, this corpus feeds a personal wiki project: agents following
  search hits back to the raw sessions and distilling them into notes. That
  lives elsewhere; this repo stays the neutral substrate.

## What is stored, and where

Everything lands on your disk and nowhere else. Sessions live in
`~/.local/share/chat-scrobbler/` as plain JSON you can read, grep, and back
up yourself. The ingest server and MCP endpoint bind to 127.0.0.1 only. The
MCP is read-only. Backups go only where you point them. There is no cloud,
no telemetry, no account. The honest caveat: your chat history may contain
secrets you pasted into an AI at 2am, and this tool makes that history very
searchable, so treat the data dir accordingly.

## Limitations (honest list)

- Attachments are stored as pointers, not bytes. Text is what is preserved.
- Capture happens while the extension and server are running. The extension
  reconciles whatever the provider sidebar lists; truly ancient history
  backfills only as you open those chats.
- The provider APIs are unofficial. A provider redesign can break a parser
  until it is updated.
- If you switch to a different branch of a forked chat without sending a new
  message, the recorded active branch can lag until the next real change.
- Chromium-only for now.

## License

MIT. See [LICENSE](LICENSE).
