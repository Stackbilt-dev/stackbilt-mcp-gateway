import { describe, it, expect } from 'vitest';
import { extractBearerToken, validateBearerToken, buildWwwAuthenticate } from '../src/auth.js';
import type { AuthServiceRpc } from '../src/types.js';

function makeRequest(authHeader?: string): Request {
  const headers = new Headers();
  if (authHeader) headers.set('Authorization', authHeader);
  return new Request('https://test.example.com', { headers });
}

function mockAuthService(overrides?: Partial<AuthServiceRpc>): AuthServiceRpc {
  return {
    validateApiKey: async () => ({ valid: true, tenant_id: 'tenant-1', tier: 'pro', scopes: ['generate', 'read'] }),
    validateJwt: async () => ({ valid: true, tenant_id: 'tenant-1', user_id: 'user-1', tier: 'free', scopes: ['read'] }),
    authenticateUser: async () => ({ valid: false }),
    registerUser: async () => ({ valid: false }),
    provisionTenant: async () => ({ tenantId: '', userId: '', tier: 'free', delinquent: false, createdAt: '' }),
    exchangeSocialCode: async () => ({ valid: false }),
    ...overrides,
  };
}

describe('extractBearerToken', () => {
  it('extracts token from Bearer header', () => {
    expect(extractBearerToken(makeRequest('Bearer sb_live_abc123'))).toBe('sb_live_abc123');
  });

  it('returns null for missing header', () => {
    expect(extractBearerToken(makeRequest())).toBeNull();
  });

  it('returns null for non-Bearer scheme', () => {
    expect(extractBearerToken(makeRequest('Basic dXNlcjpwYXNz'))).toBeNull();
  });

  it('is case-insensitive for Bearer keyword', () => {
    expect(extractBearerToken(makeRequest('bearer my-token'))).toBe('my-token');
  });
});

describe('validateBearerToken', () => {
  it('validates API key via validateApiKey RPC', async () => {
    const auth = mockAuthService();
    const result = await validateBearerToken('sb_live_test123', auth);
    expect(result).toEqual({
      authenticated: true,
      tenantId: 'tenant-1',
      tier: 'pro',
      scopes: ['generate', 'read'],
    });
  });

  it('validates JWT via validateJwt RPC', async () => {
    const auth = mockAuthService();
    const result = await validateBearerToken('eyJhbGciOiJIUzI1NiJ9.test', auth);
    expect(result).toEqual({
      authenticated: true,
      userId: 'user-1',
      tenantId: 'tenant-1',
      tier: 'free',
      scopes: ['read'],
    });
  });

  it('routes sb_test_ keys to validateApiKey', async () => {
    let called = false;
    const auth = mockAuthService({
      validateApiKey: async () => { called = true; return { valid: true, tenant_id: 't', tier: 'free', scopes: [] }; },
    });
    await validateBearerToken('sb_test_xyz', auth);
    expect(called).toBe(true);
  });

  it('returns invalid_token on API key rejection', async () => {
    const auth = mockAuthService({
      validateApiKey: async () => ({ valid: false, error: 'KEY_REVOKED' }),
    });
    const result = await validateBearerToken('sb_live_bad', auth);
    expect(result).toEqual({ authenticated: false, error: 'invalid_token' });
  });

  it('returns expired_token on TOKEN_EXPIRED', async () => {
    const auth = mockAuthService({
      validateJwt: async () => ({ valid: false, error: 'TOKEN_EXPIRED' }),
    });
    const result = await validateBearerToken('expired-jwt', auth);
    expect(result).toEqual({ authenticated: false, error: 'expired_token' });
  });

  it('returns insufficient_scope on RATE_LIMITED', async () => {
    const auth = mockAuthService({
      validateApiKey: async () => ({ valid: false, error: 'RATE_LIMITED' }),
    });
    const result = await validateBearerToken('sb_live_throttled', auth);
    expect(result).toEqual({ authenticated: false, error: 'insufficient_scope' });
  });

  it('catches RPC errors and returns invalid_token', async () => {
    const auth = mockAuthService({
      validateJwt: async () => { throw new Error('RPC timeout'); },
    });
    const result = await validateBearerToken('some-jwt', auth);
    expect(result).toEqual({ authenticated: false, error: 'invalid_token' });
  });
});

describe('buildWwwAuthenticate', () => {
  it('returns base challenge without error', () => {
    expect(buildWwwAuthenticate()).toBe('Bearer resource_metadata="/.well-known/oauth-protected-resource"');
  });

  it('includes error parameter', () => {
    const result = buildWwwAuthenticate('invalid_token');
    expect(result).toContain('error="invalid_token"');
  });
});
