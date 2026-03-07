# Stackbilt MCP Gateway — User Guide

Welcome to the Stackbilt MCP Gateway. This guide walks you through creating an account, connecting your MCP client, and using the available tools.

## What You Get

Stackbilt exposes AI tools through the [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) — an open standard that lets AI assistants use tools securely. One gateway, multiple products:

| Tool | What it does |
|------|-------------|
| `image.generate` | Generate images from text prompts via img-forge |
| `image.list_models` | List available image generation models |
| `image.check_job` | Check the status of a generation job |
| `flow.create` | Create an architecture flow via Stackbilder |
| `flow.status` | Check flow generation status |
| `flow.summary` | Get a summary of a completed flow |
| `flow.quality` | Run quality checks on a flow |
| `flow.governance` | Check governance compliance |
| `flow.advance` | Advance a flow to the next stage |
| `flow.recover` | Recover a failed flow |

**Free tier**: 50 credits/month. No credit card required. Credits are weighted by operation complexity.

---

## 1. Create Your Account

### Option A: GitHub or Google (recommended)

1. When your MCP client redirects you to `mcp.stackbilt.dev`, click **Continue with GitHub** or **Continue with Google**
2. Authorize Stackbilt to verify your identity
3. You'll be redirected back to the consent screen — click **Approve**
4. Done. Your account, tenant, and free-tier quota are created automatically.

### Option B: Email + Password

1. On the sign-in page, click **Sign up**
2. Enter your name, email, and a password (8+ characters)
3. After signup, you'll see the consent screen — click **Approve**

Both paths create the same account. You can sign in with either method later.

---

## 2. Connect Your MCP Client

The gateway uses **OAuth 2.1 with PKCE** — most MCP clients handle this automatically.

### Claude Desktop

Add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "stackbilt": {
      "url": "https://mcp.stackbilt.dev/mcp"
    }
  }
}
```

Restart Claude Desktop. It will open a browser window for authentication on first use. After approving, the connection persists until the token expires (30 days).

### Cursor / Windsurf / Other MCP Clients

Point your client to the MCP endpoint:

```
Server URL: https://mcp.stackbilt.dev/mcp
Auth: OAuth 2.1 (automatic via MCP spec)
```

The client will handle the OAuth dance — you'll see a browser popup to sign in and approve access.

### Manual / API Access

If your client doesn't support MCP OAuth natively:

1. **Register a client** (one-time):
   ```
   POST https://mcp.stackbilt.dev/register
   Content-Type: application/json

   {
     "client_name": "my-app",
     "redirect_uris": ["http://localhost:3000/callback"],
     "grant_types": ["authorization_code"],
     "response_types": ["code"],
     "token_endpoint_auth_method": "none"
   }
   ```

2. **Authorize**: redirect the user to:
   ```
   https://mcp.stackbilt.dev/authorize?
     response_type=code&
     client_id=<from_registration>&
     redirect_uri=http://localhost:3000/callback&
     scope=generate read&
     code_challenge=<S256_challenge>&
     code_challenge_method=S256&
     state=<random>
   ```

3. **Exchange the code for tokens**:
   ```
   POST https://mcp.stackbilt.dev/token
   Content-Type: application/x-www-form-urlencoded

   grant_type=authorization_code&
   code=<authorization_code>&
   redirect_uri=http://localhost:3000/callback&
   client_id=<client_id>&
   code_verifier=<original_verifier>
   ```

4. **Use the access token** with MCP JSON-RPC:
   ```
   POST https://mcp.stackbilt.dev/mcp
   Authorization: Bearer <access_token>
   Content-Type: application/json
   Accept: application/json

   {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
     "protocolVersion": "2025-03-26",
     "clientInfo": {"name": "my-app", "version": "1.0"}
   }}
   ```

---

## 3. Using Tools

Once connected, your MCP client discovers tools automatically via `tools/list`. Here's what a typical session looks like:

### Generate an Image

Ask your AI assistant:
> "Generate an image of a mountain landscape at sunset"

Behind the scenes, the client calls `image.generate` with your prompt. img-forge enhances the prompt, selects the best model, and returns the image URL.

### Create an Architecture Flow

Ask your AI assistant:
> "Create an architecture flow for a real-time chat application with WebSocket support"

Stackbilder generates a complete architecture diagram with component relationships, data flows, and deployment recommendations.

### Check a Job

If a generation is still processing:
> "Check the status of my last image generation"

The client calls `image.check_job` with the job ID from the previous response.

---

## 4. Scopes

When you approve access, you grant these scopes:

| Scope | What it allows |
|-------|---------------|
| `generate` | Create content — images, architecture flows |
| `read` | View resources — models, job status, flow details |

Both scopes are granted by default on the free tier.

---

## 5. Quota & Billing

| Tier | Credits/month | Price |
|------|--------------|-------|
| Free | 50 | $0 |
| Pro | 500 | Coming soon |
| Enterprise | 2,000 | Coming soon |

Credits are weighted by operation:

| Operation | Credits |
|-----------|---------|
| Draft quality | 1x |
| Standard quality | 2x |
| Premium quality | 5x |
| Ultra quality | 10x |

Your remaining quota is tracked automatically. When you hit the limit, tool calls return a quota error until the next billing cycle.

---

## 6. Troubleshooting

### "Session expired. Please sign in again."
Your identity token (5-minute TTL) expired between login and consent. Just try again — the flow is fast.

### "Coming Soon" page
Public signups haven't been enabled yet. If you're seeing this, you may be accessing an older endpoint. Use `mcp.stackbilt.dev`.

### MCP client can't connect
- Verify the URL is `https://mcp.stackbilt.dev/mcp` (note the `/mcp` path)
- Check that your client supports MCP protocol version `2025-03-26`
- Ensure your client handles OAuth 2.1 with PKCE

### Tool call returns "Unknown tool"
Run `tools/list` to see available tools. Tool names are namespaced: `image.generate`, not `generate_image`.

### Quota exceeded
Check your usage at the beginning of each month. Free tier resets monthly. Upgrade options coming soon.

---

## 7. Security

- **OAuth 2.1 with PKCE** — no client secrets stored on your device
- **Tokens** — access tokens expire in 1 hour, refresh tokens in 30 days
- **Service isolation** — your tool calls are routed to isolated backend workers. No cross-tenant data access.
- **HMAC-signed identity** — login sessions use short-lived cryptographic tokens, not cookies

---

## Feedback

This is an early beta. If something breaks or feels off, reach out:

- **GitHub**: [Stackbilt-dev](https://github.com/Stackbilt-dev)
- **Email**: support@stackbilt.dev

We read everything.
