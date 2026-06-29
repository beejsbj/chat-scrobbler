# MCP connector availability

chat-scrobbler exposes a read-only Streamable HTTP MCP endpoint at:

```text
http://127.0.0.1:4319/mcp
```

That endpoint is a localhost origin. It is safe to keep it bound to
`127.0.0.1`; it is not a public connector URL.

When `mcpAuthToken` or `MCP_AUTH_TOKEN` is configured, anonymous `/mcp`
requests are rejected. Authenticated clients can use either:

```text
http://127.0.0.1:4319/mcp/<token>
Authorization: Bearer <token>
```

`OPTIONS` preflight stays open so browser-based MCP clients can complete CORS
setup before sending authenticated MCP requests.

`mcpPublicBaseUrl` or `MCP_PUBLIC_BASE_URL` is only used for printing a public
connector URL. It does not change the bind address. Point your HTTPS tunnel at
the local origin and let `chat-scrobbler connect` print:

```text
https://your-tunnel.example/mcp/<token>
```

## Client matrix

| Client surface | Use the localhost URL? | Safe path |
|----------------|------------------------|-----------|
| Claude Desktop and local tools | Yes, when the client runs on the same machine. Claude Desktop should usually prefer the stdio config from `chat-scrobbler connect`. | Keep `chat-scrobbler serve` running for local HTTP clients, or use `chat-scrobbler mcp` over stdio. |
| Claude web/mobile | No. claude.ai cannot reach `127.0.0.1` on your Mac. | Requires a publicly reachable HTTPS URL. Configure `MCP_AUTH_TOKEN` and `MCP_PUBLIC_BASE_URL`, then paste the printed `/mcp/<token>` URL. |
| OpenAI Secure MCP Tunnel | Not as a public URL. The localhost URL may be the private origin if the tunnel supports this server. | Verify current tunnel requirements and configure compatible auth before exposing chat history. |
| Generic public remote MCP | No. | Requires publicly reachable HTTPS and compatible authentication. Do not publish the local endpoint without auth. |

## Claude web/mobile quick setup

1. Start or configure a public HTTPS tunnel that forwards to
   `http://127.0.0.1:4319`.
2. Set a long random capability token:

   ```bash
   export MCP_AUTH_TOKEN="$(openssl rand -hex 24)"
   export MCP_PUBLIC_BASE_URL="https://your-tunnel.example"
   ```

3. Run `chat-scrobbler serve`.
4. Run `chat-scrobbler connect` and paste the printed Claude web/mobile URL.

This token is a pragmatic capability URL, not a full account or consent system.
The MCP tools are read-only, but they can still reveal private chat history.
Treat this as personal/ephemeral exposure unless you add a stronger OAuth/Access
layer at the tunnel or identity provider.

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
