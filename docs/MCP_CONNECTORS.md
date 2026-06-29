# MCP connector availability

chat-scrobbler exposes a read-only Streamable HTTP MCP endpoint at:

```text
http://127.0.0.1:4319/mcp
```

That endpoint is a localhost origin. It is safe to keep it bound to
`127.0.0.1`; it is not a public connector URL.

## Client matrix

| Client surface | Use the localhost URL? | Safe path |
|----------------|------------------------|-----------|
| Claude Desktop and local tools | Yes, when the client runs on the same machine. Claude Desktop should usually prefer the stdio config from `chat-scrobbler connect`. | Keep `chat-scrobbler serve` running for local HTTP clients, or use `chat-scrobbler mcp` over stdio. |
| Claude web/mobile | No. claude.ai cannot reach `127.0.0.1` on your Mac. | Requires a publicly reachable HTTPS URL and compatible authentication. Cloudflare Tunnel + Access is only a candidate route until live connector compatibility is verified. |
| OpenAI Secure MCP Tunnel | Not as a public URL. The localhost URL may be the private origin if the tunnel supports this server. | Verify current tunnel requirements and configure compatible auth before exposing chat history. |
| Generic public remote MCP | No. | Requires publicly reachable HTTPS and compatible authentication. Do not publish the local endpoint without auth. |

## Tailscale Serve vs Funnel

Tailscale Serve is private to your tailnet. That is useful for your own devices
and private local tooling, but it will not make the MCP endpoint reachable from
cloud clients such as Claude web/mobile.

Tailscale Funnel is public internet exposure. Do not use Funnel for
chat-scrobbler MCP unless the endpoint is protected by authentication compatible
with the remote MCP client. The current origin endpoint is read-only, but it can
still expose private chat history.

## Practical rule

Keep the origin bound to localhost. Treat any public URL as a separate security
boundary that must provide HTTPS, authentication, and explicit compatibility
with the client surface you are connecting.
