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
  small local server. Sync badges in the chat sidebar show what is captured,
  and each chat gets its own controls: disable sync for chats you never want
  captured, or delete a captured chat (delete also marks it ignored so it does
  not quietly come back).
- **Stores forever.** Every conversation becomes one canonical JSON file with
  a shared schema across providers, including the full fork tree (edited and
  abandoned branches included), not just the visible path.
- **Searches everything.** A SQLite FTS5 index covers every message in every
  branch. One query, all providers, all history.
- **Answers agents.** A read-only MCP server exposes search/get/list, so local
  MCP clients and authenticated remote connector setups can recall your history.
  "When did I talk about rain gutters, and in which app?" is now a query.
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
chat-scrobbler init      # scaffold data dirs + config with MCP and ingest tokens
chat-scrobbler serve     # start the capture receiver + MCP endpoint
chat-scrobbler connect   # print local MCP + client-specific connector guidance
chat-scrobbler doctor    # verify config, services, index, embeddings, and tunnel
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

Search is literal by default and becomes hybrid when you enable embeddings. To
use Gemini as the cloud semantic backend:

```bash
export CHAT_SCROBBLER_EMBED_PROVIDER=gemini
export CHAT_SCROBBLER_EMBED_MODEL=gemini-embedding-2
export GEMINI_API_KEY=...
chat-scrobbler unify
chat-scrobbler search "that conversation about keeping ideas alive"
```

For a local backend, run Ollama and choose an embedding model:

```bash
ollama pull mxbai-embed-large
export CHAT_SCROBBLER_EMBED_PROVIDER=ollama
export CHAT_SCROBBLER_EMBED_MODEL=mxbai-embed-large
chat-scrobbler unify
```

`get` can narrow a conversation down for an agent: `--role` keeps only the turns
you want (`user`, `assistant`, `system`, `tool`, comma-separated), and
`--text-only` strips reasoning and tool blocks to leave just the prose. They
compose:

```bash
chat-scrobbler get chatgpt:<id> --role user                 # just your prompts
chat-scrobbler get chatgpt:<id> --role assistant --text-only # answers, no thinking
```

The MCP server exposes the same search/get/list over a read-only connector, so
MCP clients get exactly what the CLI gets. `chat-scrobbler connect` prints a
ready-to-paste Claude Desktop config, the local endpoint URL, and client-specific
remote connector cautions. See [docs/MCP_CONNECTORS.md](docs/MCP_CONNECTORS.md)
before putting the endpoint behind any tunnel.

For Claude web/mobile, keep the origin local and put a public HTTPS tunnel in
front of it. Set a capability token before exposing the tunnel:

```bash
export MCP_AUTH_TOKEN="$(openssl rand -hex 24)"
export MCP_PUBLIC_BASE_URL="https://your-tunnel.example"
chat-scrobbler serve
chat-scrobbler connect
```

With both values set, `connect` prints a Claude web/mobile URL shaped like
`https://your-tunnel.example/mcp/<token>`. Header-capable clients can instead
use `Authorization: Bearer <token>` against `/mcp`. This remains a read-only,
personal/ephemeral setup; use a stronger OAuth/Access layer before treating it
as durable shared infrastructure.

`chat-scrobbler init` generates fresh `mcpAuthToken` and `ingestToken` values
in new starter configs. If you already have a config, run `chat-scrobbler doctor`
after edits or upgrades to verify the effective config, local ingest health,
MCP HTTP endpoint, embedding setup, SQLite index, and any public MCP tunnel.

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

## Run with Docker

The repo includes a root [Dockerfile](Dockerfile) and a bjslab Coolify compose
file at [docker-compose.bjslab.yml](docker-compose.bjslab.yml). The image keeps
the normal local default intact, while the container sets `BIND_HOST=0.0.0.0`
so Coolify Traefik can reach the ingest and MCP HTTP servers on the Docker
network.

Provide `MCP_AUTH_TOKEN` and `INGEST_TOKEN` through Coolify env. After first
boot, pull the embedding model into the Ollama service:

```bash
docker compose -f docker-compose.bjslab.yml exec ollama ollama pull nomic-embed-text
```

## How I am using it

- The whole thing lives on my homelab now: the Docker compose above runs the
  server plus an Ollama sidecar, the browser extension on my laptop posts
  captures to it over my tailnet with an ingest token, and embeddings are
  local (`nomic-embed-text`), so semantic search costs nothing and leaves
  nothing. It started as a launchd agent on the Mac
  ([docs/examples/com.chat-scrobbler.serve.plist](docs/examples/com.chat-scrobbler.serve.plist));
  that still works fine for a single-machine setup.
- The MCP endpoint is reachable two ways: privately for the CLI agents that
  share my network, and through one public HTTPS hostname whose only route is
  the tokenized `/mcp/<token>` path, for Claude web. Anonymous `/mcp` gets a
  401. See [docs/MCP_CONNECTORS.md](docs/MCP_CONNECTORS.md) before exposing
  anything.
- Backups fan out to a local snapshot dir, with a second machine next on the
  list. `backupTargets` in the config is just an array.
- Longer term, this corpus feeds a personal wiki project: agents following
  search hits back to the raw sessions and distilling them into notes. That
  lives elsewhere; this repo stays the neutral substrate.

## What is stored, and where

Everything lands on your disk and nowhere else. Sessions live in
`~/.local/share/chat-scrobbler/` as plain JSON you can read, grep, and back
up yourself. The ingest server and MCP endpoint bind to 127.0.0.1 by default
(`BIND_HOST` exists for containers, where the network boundary is yours to
draw). The MCP is read-only. Backups go only where you point them. There is no cloud,
no telemetry, no account. The honest caveat: your chat history may contain
secrets you pasted into an AI at 2am, and this tool makes that history very
searchable, so treat the data dir accordingly.

## Limitations (honest list)

- Attachment files are captured to disk alongside the session JSON, but their
  contents are not embedded or searchable yet; recall sees text and filenames.
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
