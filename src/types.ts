import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

// ─── Risk Levels (Security Constitution) ─────────────────────
// Every tool declares an explicit risk level. The gateway enforces
// that tools are annotated — untyped tools are rejected at registration.
export type RiskLevel = 'READ_ONLY' | 'LOCAL_MUTATION' | 'EXTERNAL_MUTATION' | 'DESTRUCTIVE';

// ─── Auth Service RPC (stackbilt-auth Service Binding) ────────
export interface AuthServiceRpc {
  validateApiKey(rawKey: string): Promise<{
    valid: boolean;
    tenant_id?: string;
    tier?: string;
    scopes?: string[];
    key_id?: string;
    error?: string;
  }>;
  validateJwt(token: string): Promise<{
    valid: boolean;
    tenant_id?: string;
    user_id?: string;
    tier?: string;
    scopes?: string[];
    error?: string;
  }>;
  authenticateUser(email: string, password: string): Promise<{
    valid: boolean;
    userId?: string;
    email?: string;
    name?: string;
    error?: string;
  }>;
  registerUser(name: string, email: string, password: string): Promise<{
    valid: boolean;
    userId?: string;
    email?: string;
    name?: string;
    error?: string;
  }>;
  provisionTenant(params: {
    userId: string;
    source: 'oauth' | 'api_key' | 'service_binding';
  }): Promise<{
    tenantId: string;
    userId: string;
    tier: string;
    delinquent: boolean;
    createdAt: string;
  }>;
  exchangeSocialCode(code: string): Promise<{
    valid: boolean;
    userId?: string;
    email?: string;
    name?: string;
    error?: string;
  }>;
}

// ─── Backend RPC surface (what product workers expose) ────────
export interface BackendToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
  };
}

export interface BackendToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

// ─── Tier ─────────────────────────────────────────────────────
export type Tier = 'free' | 'pro' | 'enterprise';

// ─── Auth result ──────────────────────────────────────────────
export type AuthResult =
  | { authenticated: true; tenantId?: string; userId?: string; tier: Tier; scopes: string[] }
  | { authenticated: false; error: string };

// ─── Gateway Env ──────────────────────────────────────────────
export interface GatewayEnv {
  // Service Bindings
  AUTH_SERVICE: AuthServiceRpc;
  STACKBILDER: Fetcher;
  IMG_FORGE: Fetcher;

  // OAuth
  OAUTH_PROVIDER: OAuthHelpers;
  OAUTH_KV: KVNamespace;

  // Secrets
  SERVICE_BINDING_SECRET: string;

  // Config
  API_BASE_URL: string;
}
