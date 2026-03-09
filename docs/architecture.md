# Architecture

## Overview

The Stackbilt MCP Gateway is a Cloudflare Worker that acts as an OAuth-authenticated MCP endpoint, routing tool calls to backend product workers via Cloudflare service bindings.

```
MCP Client (Claude, Cursor, etc.)
    │
    ▼
┌──────────────────────────────────────┐
│  OAuthProvider (index.ts)            │
│  ├─ /health → bypass, return status  │
│  ├─ /authorize, /login, /signup,     │
│  │   /oauth/*, /register, /token     │
│  │   → oauthHandler (oauth-handler)  │
│  └─ /mcp → validateToken → gateway   │
└──────────────────────────────────────┘
          │                    │
          ▼                    ▼
   ┌─────────────┐    ┌──────────────┐
   │ AUTH_SERVICE │    │   Gateway    │
   │ (stackbilt- │    │ (gateway.ts) │
   │   auth)     │    └──────┬───────┘
   └─────────────┘           │
                    ┌────────┴────────┐
                    ▼                 ▼
             ┌────────────┐   ┌────────────┐
             │ STACKBILDER│   │  IMG_FORGE  │
             │ (edge-stack │   │ (img-forge- │
             │ -architect) │   │   mcp)      │
             └────────────┘   └────────────┘
```

## Entry Point — `index.ts`

The Worker's `fetch` handler wraps everything in `OAuthProvider` from `@cloudflare/workers-oauth-provider`. This middleware:

1. Handles `/register`, `/token`, `/.well-known/oauth-authorization-server` automatically
2. Injects `OAUTH_PROVIDER` helpers into the environment
3. Passes authenticated requests to the inner handler with `ctx.props` containing `userId`, `email`, `name`

A `/health` check bypasses OAuth entirely for uptime monitoring. CORS headers are applied to all responses.

## OAuth Handler — `oauth-handler.ts`

Handles all authentication UI and flows:

### Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/authorize` | GET | Show login form or process identity token |
| `/login` | POST | Email/password authentication |
| `/signup` | GET/POST | Account creation |
| `/oauth/github` | POST | Initiate GitHub SSO |
| `/oauth/google` | POST | Initiate Google SSO |
| `/oauth/callback` | GET | Social OAuth callback |

### Authentication Flow

1. Client redirects user to `/authorize` with standard OAuth 2.1 parameters
2. User authenticates via email/password or social SSO
3. On success, the handler creates an HMAC-SHA256 signed identity token containing `{ userId, email, name, exp }`
4. Redirects to `/authorize?identity_token=<signed_token>`
5. The authorize handler verifies the signature and 5-minute expiry
6. Auto-approves consent and calls `completeAuthorization()` to issue an authorization code
7. Client exchanges the code for tokens at `/token`

### Social OAuth Bridge

For GitHub/Google SSO, the gateway delegates to `auth.stackbilt.dev/social-bridge`:

1. Gateway stores OAuth parameters (`client_id`, `redirect_uri`, `scope`, etc.) in `OAUTH_KV` under `social_state:{uuid}` with 5-min TTL
2. Redirects to `auth.stackbilt.dev/social-bridge?provider=github&state={uuid}&return_url=...`
3. Auth service handles the provider-specific OAuth dance
4. Callback at `/oauth/callback` retrieves stored state, exchanges the code via `AUTH_SERVICE.exchangeSocialCode()`, and creates the identity token

### Coming-Soon Gate

```typescript
const PUBLIC_SIGNUPS_ENABLED = true;
```

When `false`, all auth routes return a "Coming Soon" HTML page. This gates public access without code deployment — just flip the flag.

## Gateway — `gateway.ts`

Core MCP JSON-RPC transport layer. Handles:

### Request Routing

| HTTP Method | Behavior |
|-------------|----------|
| `GET /health` | Return service status |
| `GET` (SSE) | Open event stream with keep-alive |
| `POST` | Process JSON-RPC request |
| `DELETE` | Close session |

### Session Management

- Sessions are created on `initialize` and stored in-memory
- Session ID: 32-char random hex (16 bytes via `crypto.getRandomValues`)
- TTL: 30 minutes (`SESSION_TTL_MS`)
- Garbage collection runs on every `tools/list` call, removing expired sessions
- Session ID is passed via `Mcp-Session-Id` header

### Authentication Resolution

The gateway resolves auth from two sources:

1. **OAuth context props** — `ctx.props.userId/email/name` set by OAuthProvider (primary path)
2. **Bearer token fallback** — `Authorization: Bearer <token>` validated via `AUTH_SERVICE`

On success, `provisionTenant()` is called via `AUTH_SERVICE` to ensure the user has an active tenant.

### Tool Dispatch

1. Validate tool name exists in the aggregated catalog
2. Look up route and risk level from the route table
3. Generate a trace ID (`trc_{timestamp}_{random}`)
4. Forward the request to the backend service binding as `POST /mcp` with JSON-RPC body
5. Parse response: JSON or SSE (extracts content from `message` events)
6. Emit structured audit event
7. Return result to client

## Tool Registry — `tool-registry.ts`

Aggregates tool catalogs from all backend service bindings into a unified catalog.

### How It Works

1. `buildAggregatedCatalog()` calls `tools/list` on each backend (STACKBILDER, IMG_FORGE)
2. Tools are returned with their original names (already namespaced: `image.generate`, `flow.create`)
3. Each tool must have a corresponding entry in the route table with an explicit risk level
4. Tools without declared risk levels are rejected at registration time
5. The registry maps tool names to their backend for routing

### Schema Validation

Every tool's `inputSchema` is preserved from the backend and served to clients via `tools/list`. The gateway validates that tool arguments are non-null objects before dispatch.

## Route Table — `route-table.ts`

Static mapping of tool names to backends and risk levels:

```typescript
// Risk levels (Security Constitution)
enum RiskLevel {
  READ_ONLY = 'READ_ONLY',
  LOCAL_MUTATION = 'LOCAL_MUTATION',
  EXTERNAL_MUTATION = 'EXTERNAL_MUTATION',
}
```

| Tool | Backend | Risk Level |
|------|---------|------------|
| `flow.create` | STACKBILDER | LOCAL_MUTATION |
| `flow.status` | STACKBILDER | READ_ONLY |
| `flow.summary` | STACKBILDER | READ_ONLY |
| `flow.quality` | STACKBILDER | READ_ONLY |
| `flow.governance` | STACKBILDER | READ_ONLY |
| `flow.advance` | STACKBILDER | LOCAL_MUTATION |
| `flow.recover` | STACKBILDER | LOCAL_MUTATION |
| `image.generate` | IMG_FORGE | EXTERNAL_MUTATION |
| `image.list_models` | IMG_FORGE | READ_ONLY |
| `image.check_job` | IMG_FORGE | READ_ONLY |

Risk levels are used for audit classification, not for authorization enforcement — all authenticated users can call all tools within their quota.

## Audit — `audit.ts`

Structured audit logging for every tool call, compliant with the Security Constitution.

### What Gets Logged

Each audit event includes:

- **Trace ID**: `trc_{timestamp}_{random}` for correlating request/response pairs
- **Tool name** and **risk level**
- **User ID** and **tenant ID**
- **Input summary**: first 200 chars of arguments (redacted)
- **Outcome**: success/error, duration, response size
- **Timestamp**: ISO 8601

### Secret Redaction

Before any data hits logs, the following patterns are redacted:

| Pattern | Example | Replacement |
|---------|---------|-------------|
| API keys | `sb_live_abc123...` | `[REDACTED:api_key]` |
| Bearer tokens | `Bearer eyJ...` | `[REDACTED:bearer]` |
| Long hex strings | 32+ hex chars | `[REDACTED:hash]` |
| Sensitive fields | `password`, `secret`, `api_key` | Values replaced with `[REDACTED]` |

### Dual Output

Audit events are sent to:

1. `console.log` — captured by Cloudflare Workers logging
2. `PLATFORM_EVENTS_QUEUE` — `stackbilt-user-events` queue for the BizOps pipeline

## Auth — `auth.ts`

Bearer token extraction and validation for non-OAuth paths:

1. Extracts token from `Authorization: Bearer <token>` header
2. Validates via `AUTH_SERVICE` (delegated to the auth worker)
3. Maps auth errors to HTTP status codes (401 for invalid/expired, 403 for rate-limited/delinquent)

## Security Model

### Defense in Depth

1. **OAuth 2.1 + PKCE**: No client secrets stored on devices; code verifier prevents interception
2. **HMAC-signed identity tokens**: Tamper-proof, 5-minute TTL, replaces cookies in stateless flow
3. **Open redirect prevention**: OAuth deny flow validates `redirect_uri` against registered client before redirecting
4. **Secret redaction**: No sensitive data in logs — API keys, tokens, passwords all scrubbed
5. **Null safety**: Tool arguments validated as objects before dispatch; session IDs checked before operations
6. **Service isolation**: Each backend runs in its own Worker; the gateway proxies without cross-tenant data leakage

### Rate Limiting

Enforced by `AUTH_SERVICE` (delegated to the auth worker). The gateway receives:

- `insufficient_scope` (403) — rate limited or payment delinquent
- `invalid_token` (401) — expired or invalid token

## Dependencies

| Package | Purpose |
|---------|---------|
| `@modelcontextprotocol/sdk` | MCP protocol types and utilities |
| `@cloudflare/workers-oauth-provider` | OAuth 2.1 + PKCE provider middleware |
| `agents` | Cloudflare Agents SDK |
| `zod` | Schema validation |
