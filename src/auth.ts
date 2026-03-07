// ─── Auth Validation ──────────────────────────────────────────
// Delegates all credential checks to stackbilt-auth via Service Binding RPC.
// Identity is enforced server-side — the gateway never trusts client claims.

import type { AuthResult, AuthServiceRpc, Tier } from './types.js';

function isApiKey(token: string): boolean {
  return token.startsWith('sb_live_') || token.startsWith('sb_test_');
}

function mapError(error?: string): string {
  switch (error) {
    case 'TOKEN_EXPIRED':
    case 'KEY_EXPIRED':
      return 'expired_token';
    case 'RATE_LIMITED':
    case 'PAYMENT_DELINQUENT':
      return 'insufficient_scope';
    default:
      return 'invalid_token';
  }
}

export function extractBearerToken(request: Request): string | null {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

export async function validateBearerToken(
  token: string,
  authService: AuthServiceRpc,
): Promise<AuthResult> {
  try {
    if (isApiKey(token)) {
      const result = await authService.validateApiKey(token);
      if (!result.valid) {
        return { authenticated: false, error: mapError(result.error) };
      }
      return {
        authenticated: true,
        tenantId: result.tenant_id,
        tier: (result.tier ?? 'free') as Tier,
        scopes: result.scopes ?? [],
      };
    }

    const result = await authService.validateJwt(token);
    if (!result.valid) {
      return { authenticated: false, error: mapError(result.error) };
    }
    return {
      authenticated: true,
      userId: result.user_id,
      tenantId: result.tenant_id,
      tier: (result.tier ?? 'free') as Tier,
      scopes: result.scopes ?? [],
    };
  } catch {
    return { authenticated: false, error: 'invalid_token' };
  }
}

export function buildWwwAuthenticate(error?: string): string {
  const parts = ['Bearer resource_metadata="/.well-known/oauth-protected-resource"'];
  if (error) parts.push(`error="${error}"`);
  return parts.join(', ');
}
