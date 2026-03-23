# API Reference

## MCP Endpoint

```
POST https://mcp.stackbilt.dev/mcp
```

All tool interactions use MCP JSON-RPC 2.0 over HTTP. The gateway supports protocol version `2025-03-26`.

---

## Authentication Flow

The gateway uses **OAuth 2.1 with PKCE** via `@cloudflare/workers-oauth-provider`.

### 1. Client Registration

```
POST /register
Content-Type: application/json

{
  "client_name": "my-app",
  "redirect_uris": ["http://localhost:3000/callback"],
  "grant_types": ["authorization_code"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none"
}
```

Returns a `client_id` for subsequent authorization requests.

### 2. Authorization

```
GET /authorize?response_type=code&client_id=<id>&redirect_uri=<uri>&scope=generate+read&code_challenge=<S256>&code_challenge_method=S256&state=<random>
```

Presents the user with a login form. Authentication options:

| Method | Endpoint | Flow |
|--------|----------|------|
| Email/password | `POST /login` | Form submission → `AUTH_SERVICE.authenticateUser()` |
| GitHub SSO | `POST /oauth/github` | Redirect to `auth.stackbilt.dev/social-bridge` → callback |
| Google SSO | `POST /oauth/google` | Redirect to `auth.stackbilt.dev/social-bridge` → callback |

After successful authentication, the gateway signs an HMAC-SHA256 identity token (5-minute TTL) and redirects back to `/authorize` with the token. The authorize handler verifies the token, auto-approves consent, and completes the OAuth flow by returning an authorization code.

### 3. Token Exchange

```
POST /token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&code=<code>&redirect_uri=<uri>&client_id=<id>&code_verifier=<verifier>
```

Returns an access token and refresh token.

### 4. Authenticated MCP Requests

```
POST /mcp
Authorization: Bearer <access_token>
Content-Type: application/json
Accept: application/json

{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {...}}
```

The gateway resolves authentication from OAuth context props (`userId`, `email`, `name`) set during the authorization flow. These are injected by `OAuthProvider` middleware.

---

## MCP Methods

### `initialize`

Creates a new session. Returns a `Mcp-Session-Id` header that must be included in subsequent requests.

```json
{
  "jsonrpc": "2.0", "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-03-26",
    "clientInfo": {"name": "my-app", "version": "1.0"}
  }
}
```

Response includes `serverInfo` with gateway name and version, plus supported capabilities.

Sessions have a 30-minute TTL and are garbage-collected on `tools/list` calls.

### `tools/list`

Returns the aggregated tool catalog from all backend adapters.

```json
{"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}
```

Tools are namespaced by product (e.g. `image_generate`, `flow_create`). Each tool includes a JSON Schema for its `inputSchema`.

### `tools/call`

Invokes a tool on the appropriate backend.

```json
{
  "jsonrpc": "2.0", "id": 3,
  "method": "tools/call",
  "params": {
    "name": "image_generate",
    "arguments": {"prompt": "A mountain at sunset"}
  }
}
```

The gateway:
1. Validates the tool name exists in the catalog
2. Looks up the risk level from the route table
3. Generates a trace ID for audit
4. Proxies the call to the appropriate backend service binding
5. Parses the response (JSON or SSE)
6. Emits a structured audit event (to console + queue)
7. Returns the tool result

### `ping`

Health check. Returns a pong response.

### `notifications/initialized`

Client notification after initialization. Acknowledged silently.

---

## Tools — Stackbilder

Routed to the `STACKBILDER` service binding (`edge-stack-architect-v2`).

### `flow_create`

Create a new architecture flow.

- **Risk level**: `LOCAL_MUTATION`
- **Arguments**: Varies by flow type (prompt, configuration)

### `flow_status`

Check the generation status of a flow.

- **Risk level**: `READ_ONLY`
- **Arguments**: `flowId`

### `flow_summary`

Get a summary of a completed flow.

- **Risk level**: `READ_ONLY`
- **Arguments**: `flowId`

### `flow_quality`

Run quality checks on a flow.

- **Risk level**: `READ_ONLY`
- **Arguments**: `flowId`

### `flow_governance`

Check governance compliance of a flow.

- **Risk level**: `READ_ONLY`
- **Arguments**: `flowId`

### `flow_advance`

Advance a flow to the next stage.

- **Risk level**: `LOCAL_MUTATION`
- **Arguments**: `flowId`

### `flow_recover`

Recover a failed flow.

- **Risk level**: `LOCAL_MUTATION`
- **Arguments**: `flowId`

---

## Tools — img-forge

Routed to the `IMG_FORGE` service binding (`img-forge-mcp`).

### `image_generate`

Generate an image from a text prompt.

- **Risk level**: `EXTERNAL_MUTATION`
- **Arguments**: `prompt` (string), plus optional model/quality parameters

### `image_list_models`

List available image generation models.

- **Risk level**: `READ_ONLY`
- **Arguments**: None

### `image_check_job`

Check the status of an image generation job.

- **Risk level**: `READ_ONLY`
- **Arguments**: `jobId`

---

## Tools — TarotScript (Scaffold)

Routed to the `TAROTSCRIPT` service binding (`tarotscript-worker`). REST API backend (gateway translates to/from MCP JSON-RPC). Timeout: 60s.

### `scaffold_create`

Create a new project scaffold from a prompt. Generates structured facts and deployable project files.

- **Risk level**: `LOCAL_MUTATION`
- **Arguments**: Varies by project type (prompt, configuration options)

### `scaffold_classify`

Classify a prompt or project description to determine the appropriate scaffold template.

- **Risk level**: `READ_ONLY`
- **Arguments**: Project description or prompt to classify

### `scaffold_status`

Check the status of a scaffold generation job.

- **Risk level**: `READ_ONLY`
- **Arguments**: `flowId` or scaffold job identifier

### `scaffold_publish`

Publish a completed scaffold to a GitHub repository.

- **Risk level**: `EXTERNAL_MUTATION`
- **Arguments**: Scaffold identifier, target repository details

### `scaffold_deploy`

Deploy a published scaffold to Cloudflare Workers.

- **Risk level**: `EXTERNAL_MUTATION`
- **Arguments**: Scaffold identifier, deployment configuration

### `scaffold_import`

Import an n8n workflow and convert it to a scaffold. Routed via the `TRANSPILER` service binding (`n8n-transpiler`).

- **Risk level**: `LOCAL_MUTATION`
- **Arguments**: n8n workflow JSON or URL

---

## Tools — Visual QA

Routed to the `VISUAL_QA` service binding (`stackbilt-visual-qa`). REST API backend (gateway translates to/from MCP JSON-RPC).

### `visual_screenshot`

Capture a screenshot of a deployed page or URL.

- **Risk level**: `LOCAL_MUTATION`
- **Arguments**: URL or page identifier

### `visual_analyze`

Analyze a screenshot or page for visual quality, layout issues, and accessibility.

- **Risk level**: `LOCAL_MUTATION`
- **Arguments**: Screenshot or URL to analyze

### `visual_pages`

List available pages for a deployed project.

- **Risk level**: `READ_ONLY`
- **Arguments**: Project or deployment identifier

---

## Tool Routing & SERVICE_BINDING_SECRET Pattern

### How Tool Routing Works

1. **Registration**: On startup, the tool registry fetches `tools/list` from each backend service binding (STACKBILDER, IMG_FORGE, TAROTSCRIPT, VISUAL_QA)
2. **Namespacing**: Tools are prefixed by product (`flow_*`, `image_*`, `scaffold_*`, `visual_*`) to avoid name collisions
3. **Route table**: A static mapping (`src/route-table.ts`) maps each tool name to its backend and risk level
4. **Dispatch**: On `tools/call`, the gateway resolves the route, forwards the request to the correct service binding, and returns the result

### SERVICE_BINDING_SECRET

The `SERVICE_BINDING_SECRET` is used to sign HMAC-SHA256 identity tokens during the OAuth flow. These tokens:

- Carry user identity (`userId`, `email`, `name`) between the login step and the consent/authorize step
- Expire after 5 minutes
- Are verified on every parse to prevent tampering
- Format: `base64(JSON_payload).hex(HMAC_signature)`

This replaces cookies in the stateless OAuth flow, keeping the gateway fully stateless.

---

## Scopes

| Scope | Allows |
|-------|--------|
| `generate` | Create content — images, architecture flows |
| `read` | View resources — models, job status, flow details |

---

## Error Responses

Standard MCP JSON-RPC error codes:

| Code | Meaning |
|------|---------|
| `-32600` | Invalid request |
| `-32601` | Method not found |
| `-32602` | Invalid params |
| `-32603` | Internal error |

HTTP-level errors:

| Status | Meaning |
|--------|---------|
| `400` | Missing or malformed request |
| `401` | Invalid or expired token (`invalid_token`) |
| `403` | Rate limited or payment delinquent (`insufficient_scope`) |
| `404` | Unknown path |
| `405` | Method not allowed |

---

## Health Check

```
GET /health
```

Bypasses OAuth. Returns `200 OK` with service status. Useful for uptime monitoring.

---

## SSE Transport

For streaming responses, send a `GET` request with `Accept: text/event-stream`:

```
GET /mcp
Authorization: Bearer <access_token>
Mcp-Session-Id: <session_id>
Accept: text/event-stream
```

The gateway keeps the connection alive with periodic heartbeat events.

To close a session:

```
DELETE /mcp
Mcp-Session-Id: <session_id>
```
