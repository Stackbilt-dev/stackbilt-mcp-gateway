# Service Integration Contract

## Identity Delegation Flow

When the MCP gateway proxies a tool call to a backend worker, it delegates the authenticated user's identity via HTTP headers. This document defines the header contract between the gateway and all backend workers.

### Request Flow

```
MCP Client (Claude Code, Claude.ai, Cursor)
    │ OAuth token
    ▼
┌──────────────────────────────────────────────────┐
│  stackbilt-mcp-gateway                           │
│  ├─ OAuthProvider validates token                │
│  ├─ resolveAuth() → provisionTenant() via AUTH   │
│  │   Returns: userId, tenantId, tier, scopes     │
│  └─ proxyToolCall() → service binding fetch      │
│      Headers:                                    │
│        X-Service-Binding: <shared secret>        │
│        X-Gateway-Tenant-Id: <tenant UUID>        │
│        X-Gateway-User-Id: <user ID>              │
│        X-Tenant-User-Id: <user ID>               │
│        X-Gateway-Tier: free|hobby|pro            │
│        X-Gateway-Scopes: generate,read           │
└──────────────────┬───────────────────────────────┘
                   │ service binding (no public network)
                   ▼
┌──────────────────────────────────────────────────┐
│  Backend Worker (e.g. img-forge-mcp)             │
│  ├─ Reads X-Gateway-User-Id → delegatedUserId   │
│  ├─ Passes to product gateway as:               │
│  │   X-Service-Binding: <backend's own secret>   │
│  │   X-Tenant-User-Id: <delegatedUserId>         │
│  └─ Product gateway calls AUTH resolveTenant()   │
└──────────────────────────────────────────────────┘
```

### Header Contract

| Header | Direction | Value | Purpose |
|--------|-----------|-------|---------|
| `X-Service-Binding` | Gateway → Backend | Shared secret | Proves the request comes from a trusted service binding, bypasses public auth |
| `X-Gateway-User-Id` | Gateway → Backend | User ID (e.g. `github\|12345`) | The authenticated user's identity — used for tenant resolution downstream |
| `X-Gateway-Tenant-Id` | Gateway → Backend | Tenant UUID | The resolved tenant ID — for backends that trust it directly |
| `X-Tenant-User-Id` | MCP layer → Product gateway | User ID | img-forge convention: the user ID for `resolveTenant()` calls |
| `X-Gateway-Tier` | Gateway → Backend | `free`, `hobby`, `pro` | Subscription tier for quota/feature gating |
| `X-Gateway-Scopes` | Gateway → Backend | Comma-separated | Authorized scopes (e.g. `generate,read`) |

### Identity vs Tenant

These are distinct concepts that have caused bugs when conflated:

- **User ID** (`X-Gateway-User-Id`): The OAuth identity. Format varies by provider (e.g. `github|12345`, email, UUID). Used to look up or provision a tenant.
- **Tenant ID** (`X-Gateway-Tenant-Id`): The provisioned tenant UUID from AUTH_SERVICE. Represents the billing/quota entity. A user maps to exactly one tenant.

**Rule**: When a downstream service needs to call `resolveTenant()` or `provisionTenant()`, it needs the **user ID**, not the tenant ID. The tenant ID is the *output* of that call.

### Backend Integration Patterns

#### Pattern A: MCP Wrapper → Product Gateway (img-forge)

```
Gateway → img-forge-mcp (reads X-Gateway-User-Id)
                │
                └→ img-forge-gateway (receives X-Tenant-User-Id + X-Service-Binding)
                        │
                        └→ AUTH_SERVICE.resolveTenant({ userId })
```

The MCP wrapper translates gateway headers into the product gateway's native auth contract. The product gateway does its own tenant resolution via AUTH_SERVICE.

#### Pattern B: Direct Backend (Stackbilder, TarotScript)

```
Gateway → backend worker (reads X-Gateway-Tenant-Id directly)
```

Backends that trust the gateway's tenant resolution can use `X-Gateway-Tenant-Id` directly without calling AUTH_SERVICE again.

### Failure Modes

| Failure | Symptom | Root Cause | Fix |
|---------|---------|------------|-----|
| `TENANT_NOT_FOUND` | 404 from backend | Wrong ID type passed (tenant ID where user ID expected) | Ensure MCP wrappers read `X-Gateway-User-Id` |
| Empty tenant ID | 404 or silent failure | `resolveAuth()` fallback on `provisionTenant()` error | Gateway now fails request instead of proceeding |
| `SERVICE_BINDING_INVALID` | 401 from backend | Mismatched secrets between gateway and backend | Verify `SERVICE_BINDING_SECRET` matches on both workers |
| Stale session | Intermittent auth failures | KV session cached with bad/missing tenant ID | Session TTL is 30min; should self-heal |

### Design Improvement Opportunities

1. **Standardize header names**: `X-Tenant-User-Id` (img-forge) vs `X-Gateway-User-Id` (gateway convention). Should converge on one name across all backends.
2. **Eliminate double tenant resolution**: img-forge resolves tenant again via AUTH_SERVICE even though the gateway already did. Pattern B (trust gateway) is more efficient. Requires backends to trust `X-Gateway-Tenant-Id` + `X-Service-Binding` as proof.
3. **Header validation middleware**: A shared package that validates the gateway header contract on the backend side, with clear error messages for each failure mode.
4. **Contract tests**: Cross-worker integration tests that verify header propagation end-to-end. Currently only unit-tested per worker.
5. **Observability**: Log the full header chain at each hop when errors occur, so the identity mismatch is visible in a single trace.

### Lessons Learned

- Backend workers must read `X-Gateway-User-Id` (user ID), not `X-Gateway-Tenant-Id` (tenant UUID), when they need to call `resolveTenant()` or `provisionTenant()`. The tenant ID is the *output* of that call.
- The gateway must fail requests explicitly when `provisionTenant()` errors, rather than silently falling back to an empty tenant.
