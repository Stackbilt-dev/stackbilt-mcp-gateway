# stackbilt-mcp-gateway

MCP gateway on Cloudflare Workers using `@modelcontextprotocol/sdk` and `@cloudflare/workers-oauth-provider`.

## Environment

| Context | Path |
|---------|------|
| WSL2 | `/mnt/c/Users/kover/Documents/stackbilt-mcp-gateway` |

## Commands

```bash
npm install          # install dependencies
npm run typecheck    # tsc --noEmit
npm run test         # vitest run
npm run test:watch   # vitest (watch mode)
npm run dev          # wrangler dev
npm run deploy       # wrangler deploy
```

## Worker Config

| Key | Value |
|-----|-------|
| Worker name | `stackbilt-mcp-gateway` |
| Entrypoint | `src/index.ts` |
| Domain | `mcp.stackbilt.dev` |

## Bindings

| Binding | Type | Target |
|---------|------|--------|
| `AUTH_SERVICE` | Service | `stackbilt-auth` (entrypoint: `AuthEntrypoint`) |
| `STACKBILDER` | Service | `edge-stack-architect-v2` |
| `IMG_FORGE` | Service | `img-forge-mcp` |
| `OAUTH_KV` | KV Namespace | *(see wrangler.toml)* |
| `PLATFORM_EVENTS_QUEUE` | Queue | `stackbilt-user-events` |

## Vars

| Name | Value |
|------|-------|
| `API_BASE_URL` | `https://mcp.stackbilt.dev` |
