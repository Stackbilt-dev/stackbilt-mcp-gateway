# Stackbilt MCP Gateway — User Guide

Welcome to the Stackbilt MCP Gateway. This guide walks you through creating an account, connecting your MCP client, and using the available tools.

## What You Get

Stackbilt exposes AI tools through the [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) — an open standard that lets AI assistants use tools securely. One gateway, multiple products:

| Tool | What it does | Risk |
|------|-------------|------|
| **Scaffold** | | |
| `scaffold_create` | Generate project scaffold — structured facts + deployable files from a description | LOCAL_MUTATION |
| `scaffold_classify` | Classify a message into intent categories (zero LLM) | READ_ONLY |
| `scaffold_publish` | Publish files to a GitHub repository (atomic multi-file commit) | EXTERNAL_MUTATION |
| `scaffold_status` | Check TarotScript engine health and available spreads | READ_ONLY |
| **img-forge** | | |
| `image_generate` | Generate images from text prompts (5 quality tiers: draft → ultra_plus) | EXTERNAL_MUTATION |
| `image_list_models` | List available image generation models and tiers | READ_ONLY |
| `image_check_job` | Check the status of an async generation job | READ_ONLY |
| **Stackbilder** *(legacy — migrating to scaffold_\*)* | | |
| `flow_create` | Create an architecture flow via LLM orchestration | LOCAL_MUTATION |
| `flow_status` | Check flow generation status | READ_ONLY |
| `flow_summary` | Get a completed flow summary | READ_ONLY |
| `flow_quality` | Get per-mode quality scores | READ_ONLY |
| `flow_governance` | Check governance posture | READ_ONLY |
| `flow_advance` | Advance a flow to the next stage | LOCAL_MUTATION |
| `flow_recover` | Recover a failed flow | LOCAL_MUTATION |

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

Once connected, your MCP client discovers tools automatically via `tools/list`. Here's what you can do:

### Scaffold a Project (E2E)

The scaffold pipeline turns a project description into a deployable GitHub repository in two tool calls.

**Step 1: Generate the scaffold**

Ask your AI assistant:
> "Scaffold a Cloudflare Workers API for managing restaurant menu items with D1 storage"

Behind the scenes, the client calls `scaffold_create`:

```json
{
  "name": "scaffold_create",
  "arguments": {
    "intention": "A Cloudflare Workers API for managing restaurant menu items with D1 storage",
    "project_type": "api",
    "complexity": "moderate"
  }
}
```

You'll receive structured output:

- **`facts`** — 40+ key-value pairs covering product requirements, UX patterns, security threats, runtime decisions, test plans, and sprint tasks
- **`files`** — 9 deployable project files: `.ai/` governance, `package.json`, `tsconfig.json`, `wrangler.toml`, `src/index.ts`, `test/index.test.ts`, `README.md`
- **`nextSteps`** — what to do after scaffolding
- **`receipt`** — cryptographic hash + seed for reproducibility
- **`analysis`** — card positions, elemental census, dignity pairs (TarotScript symbolic analysis)

All files are generated deterministically from the TarotScript deck engine. Zero LLM calls. ~20ms for structure.

**Step 2: Publish to GitHub**

Ask your assistant:
> "Publish those files to a GitHub repo called restaurant-menu-api"

The client calls `scaffold_publish`:

```json
{
  "name": "scaffold_publish",
  "arguments": {
    "repo_name": "restaurant-menu-api",
    "owner": "your-org",
    "files": [...the files array from step 1...],
    "description": "Restaurant menu API — scaffolded by Stackbilt"
  }
}
```

Response:

```json
{
  "repo_url": "https://github.com/your-org/restaurant-menu-api",
  "clone_url": "https://github.com/your-org/restaurant-menu-api.git",
  "commit_sha": "5a6dad89...",
  "files_committed": 9,
  "next_steps": [
    "git clone https://github.com/your-org/restaurant-menu-api.git",
    "npm install",
    "npx wrangler d1 create restaurant-menu-api",
    "npx wrangler deploy"
  ]
}
```

**Step 3: Deploy**

```bash
git clone https://github.com/your-org/restaurant-menu-api.git
cd restaurant-menu-api
npm install
npx wrangler d1 create restaurant-menu-api  # update database_id in wrangler.toml
npx wrangler deploy
```

Your Worker is live. The entire flow — describe, scaffold, publish, deploy — can happen in a single AI conversation.

### Generate an Image

Ask your AI assistant:
> "Generate an image of a mountain landscape at sunset"

The client calls `image_generate` with your prompt. img-forge enhances the prompt, selects the best model for your quality tier, and returns:

```json
{
  "url": "https://imgforge.stackbilt.dev/images/abc123.png",
  "model": "flux-dev",
  "quality_tier": "premium",
  "enhanced_prompt": "A breathtaking mountain landscape at golden hour..."
}
```

**Quality tiers**: `draft` (fastest, SDXL), `standard` (FLUX Klein, default), `premium` (FLUX Dev), `ultra` (Gemini 2.5 Flash), `ultra_plus` (Gemini 3.1 Flash).

### Classify Intent

Use `scaffold_classify` for zero-inference intent classification:

> "What kind of request is 'help me debug this authentication error'?"

```json
{
  "name": "scaffold_classify",
  "arguments": { "message": "help me debug this authentication error" }
}
```

Returns primary classification, confidence, secondary intent, and compound intent detection. Zero LLM calls — uses semantic keyword matching against the TarotScript aegis-intents deck.

### Import an n8n Workflow

Have an existing n8n automation? Convert it to an edge-native Cloudflare Worker:

> "Import this n8n workflow and convert it to a Worker"

The client calls `scaffold_import`:

```json
{
  "name": "scaffold_import",
  "arguments": {
    "workflow": { ...your n8n workflow JSON... }
  }
}
```

The transpiler parses your n8n nodes (webhooks, HTTP requests, conditionals, loops, database queries, AI calls) and generates a complete Worker project:

```json
{
  "files": [
    { "path": "src/index.ts", "content": "// Full transpiled Worker..." },
    { "path": "wrangler.toml", "content": "// Bindings, secrets, queues..." },
    { "path": "package.json", "content": "..." },
    { "path": "README.md", "content": "// Setup + deploy instructions..." }
  ],
  "summary": {
    "workflowName": "My Automation",
    "totalNodes": 8,
    "supportedNodes": 8,
    "unsupportedNodes": 0,
    "resources": { "secrets": 2, "databases": 1, "queues": 1 }
  }
}
```

Pipe the `files[]` output to `scaffold_publish` → `scaffold_deploy` for full E2E: n8n workflow → deployed edge Worker in one conversation.

**Supported n8n nodes**: Webhook, Schedule, HTTP Request, IF/Switch, Loop, Database (Postgres/MySQL via Hyperdrive), AI (OpenAI → Workers AI), Edit Fields, Set.

### Check Engine Status

> "Is the scaffold engine healthy?"

Calls `scaffold_status` — returns available spreads, deck statistics, and engine health.

---

## 4. Scopes

When you approve access, you grant these scopes:

| Scope | What it allows |
|-------|---------------|
| `generate` | Create content — scaffolds, images, flows, GitHub repos |
| `read` | View resources — models, job status, engine health, classifications |

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
Run `tools/list` to see available tools. Tool names use underscore namespacing: `scaffold_create`, `image_generate`, not `generate_image`.

### scaffold_publish needs a GitHub token
Pass `github_token` as a parameter with a GitHub PAT that has `repo` scope. Or ask the gateway operator to set the `GITHUB_TOKEN` secret.

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
