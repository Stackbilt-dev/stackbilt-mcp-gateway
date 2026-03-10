import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { redact, summarizeInput, generateTraceId, emitAudit, type AuditArtifact } from '../src/audit.js';
import { handleMcpRequest } from '../src/gateway.js';
import type { GatewayEnv, AuthServiceRpc } from '../src/types.js';

// ─── Unit tests: redaction ───────────────────────────────────

describe('redact', () => {
  it('scrubs API keys', () => {
    expect(redact('token sb_live_abc123def')).toBe('token [REDACTED_KEY]');
    expect(redact('key=sb_test_xyz789')).toBe('key=[REDACTED_KEY]');
  });

  it('scrubs Bearer tokens', () => {
    expect(redact('Authorization: Bearer eyJhbGciOi...')).toBe('Authorization: Bearer [REDACTED]');
  });

  it('scrubs hex hashes (32+ chars)', () => {
    const hash = 'a'.repeat(32);
    expect(redact(`id: ${hash}`)).toBe('id: [REDACTED_HASH]');
  });

  it('scrubs password fields', () => {
    expect(redact('password: "hunter2"')).toBe('password:[REDACTED]');
    expect(redact('"password":"secret123"')).toBe('"password:[REDACTED]');
  });

  it('scrubs secret fields', () => {
    expect(redact('secret: my_secret_value')).toBe('secret:[REDACTED]');
  });

  it('scrubs api_key fields', () => {
    expect(redact('api_key: "sk-1234"')).toBe('api_key:[REDACTED]');
    // No trailing quote because the regex consumes unquoted values fully
    expect(redact('apiKey=mykey123')).toContain('[REDACTED]');
    expect(redact('apiKey=mykey123')).not.toContain('mykey123');
  });

  it('leaves safe strings untouched', () => {
    expect(redact('prompt: a cat sitting on a mat')).toBe('prompt: a cat sitting on a mat');
  });

  it('handles multiple secrets in one string', () => {
    const input = 'key=sb_live_abc token=Bearer xyz password: "p4ss"';
    const result = redact(input);
    expect(result).not.toContain('sb_live_abc');
    expect(result).not.toContain('xyz');
    expect(result).not.toContain('p4ss');
  });
});

describe('summarizeInput', () => {
  it('returns {} for null/undefined', () => {
    expect(summarizeInput(null)).toBe('{}');
    expect(summarizeInput(undefined)).toBe('{}');
  });

  it('serializes objects', () => {
    expect(summarizeInput({ prompt: 'a cat' })).toBe('{"prompt":"a cat"}');
  });

  it('truncates long input', () => {
    const long = { data: 'x'.repeat(300) };
    const result = summarizeInput(long, 200);
    expect(result.length).toBeLessThanOrEqual(203); // 200 + '...'
    expect(result).toMatch(/\.\.\.$/);
  });

  it('redacts secrets in input summary', () => {
    const input = { password: 'hunter2', api_key: 'sk-1234' };
    const result = summarizeInput(input);
    expect(result).not.toContain('hunter2');
    expect(result).not.toContain('sk-1234');
  });
});

describe('generateTraceId', () => {
  it('returns 32-char hex string', () => {
    const id = generateTraceId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateTraceId()));
    expect(ids.size).toBe(100);
  });
});

describe('emitAudit', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it('emits [audit] prefixed JSON', () => {
    const artifact: AuditArtifact = {
      trace_id: 'abc123',
      principal: 'user-1',
      tenant: 'tenant-1',
      tool: 'image.generate',
      risk_level: 'EXTERNAL_MUTATION',
      policy_decision: 'ALLOW',
      redacted_input_summary: '{"prompt":"a cat"}',
      outcome: 'success',
      timestamp: '2026-03-07T20:00:00Z',
    };
    emitAudit(artifact);

    expect(logSpy).toHaveBeenCalledOnce();
    const logged = logSpy.mock.calls[0][0] as string;
    expect(logged).toMatch(/^\[audit\] /);

    const json = JSON.parse(logged.replace('[audit] ', ''));
    expect(json.trace_id).toBe('abc123');
    expect(json.tool).toBe('image.generate');
    expect(json.outcome).toBe('success');
  });

  it('redacts secrets that sneak into artifact fields', () => {
    const artifact: AuditArtifact = {
      trace_id: 'abc',
      principal: 'sb_live_leaked_key',
      tenant: 'tenant-1',
      tool: 'test',
      risk_level: 'READ_ONLY',
      policy_decision: 'ALLOW',
      redacted_input_summary: 'sb_live_leaked_key',
      outcome: 'success',
      timestamp: '2026-03-07T20:00:00Z',
    };
    emitAudit(artifact);

    const logged = logSpy.mock.calls[0][0] as string;
    expect(logged).not.toContain('sb_live_leaked_key');
    expect(logged).toContain('[REDACTED_KEY]');
  });

  it('includes all mandatory fields', () => {
    const artifact: AuditArtifact = {
      trace_id: 't1',
      principal: 'p1',
      tenant: 'ten1',
      tool: 'flow.create',
      risk_level: 'LOCAL_MUTATION',
      policy_decision: 'DENY',
      redacted_input_summary: '{}',
      outcome: 'invalid_params',
      timestamp: '2026-03-07T20:00:00Z',
      latency_ms: 42,
    };
    emitAudit(artifact);

    const json = JSON.parse((logSpy.mock.calls[0][0] as string).replace('[audit] ', ''));
    const required = ['trace_id', 'principal', 'tenant', 'tool', 'risk_level', 'policy_decision', 'redacted_input_summary', 'outcome', 'timestamp'];
    for (const field of required) {
      expect(json, `missing field: ${field}`).toHaveProperty(field);
    }
    expect(json.latency_ms).toBe(42);
  });
});

// ─── Integration: audit emission from gateway ────────────────

describe('gateway audit integration', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  function mockAuthService(tier = 'pro'): AuthServiceRpc {
    return {
      validateApiKey: async () => ({ valid: true, tenant_id: 'tenant-1', tier, scopes: ['generate', 'read'] }),
      validateJwt: async () => ({ valid: true, tenant_id: 'tenant-1', user_id: 'user-1', tier, scopes: ['read'] }),
      authenticateUser: async (_e: string, _p: string) => ({ valid: false }),
      registerUser: async (_n: string, _e: string, _p: string) => ({ valid: false }),
      provisionTenant: async (_p: { userId: string; source: string }) => ({ tenantId: '', userId: '', tier: 'free', delinquent: false, createdAt: '' }),
      exchangeSocialCode: async (_c: string) => ({ valid: false }),
    };
  }

  function makeEnv(overrides?: Partial<GatewayEnv>): GatewayEnv {
    return {
      AUTH_SERVICE: mockAuthService(),
      STACKBILDER: {
        fetch: async () => new Response(JSON.stringify({
          jsonrpc: '2.0', id: 1,
          result: { content: [{ type: 'text', text: 'ok' }] },
        }), { headers: { 'Content-Type': 'application/json' } }),
        connect: () => { throw new Error('not implemented'); },
      } as unknown as Fetcher,
      IMG_FORGE: {
        fetch: async () => new Response(JSON.stringify({
          jsonrpc: '2.0', id: 1,
          result: { content: [{ type: 'text', text: 'ok' }] },
        }), { headers: { 'Content-Type': 'application/json' } }),
        connect: () => { throw new Error('not implemented'); },
      } as unknown as Fetcher,
      OAUTH_PROVIDER: {} as any,
      OAUTH_KV: {} as any,
      PLATFORM_EVENTS_QUEUE: { send: async () => {} } as unknown as Queue,
      SERVICE_BINDING_SECRET: 'test-secret',
      API_BASE_URL: 'https://mcp.stackbilt.dev',
      ...overrides,
    };
  }

  function rpcRequest(method: string, params?: unknown, headers?: Record<string, string>): Request {
    return new Request('https://mcp.stackbilt.dev/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: 'Bearer sb_live_test123',
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
  }

  async function getSession(env: GatewayEnv): Promise<string> {
    const req = rpcRequest('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test' } });
    const res = await handleMcpRequest(req, env);
    return res.headers.get('MCP-Session-Id')!;
  }

  function getAuditLogs(): AuditArtifact[] {
    return logSpy.mock.calls
      .map(c => c[0] as string)
      .filter(s => s.startsWith('[audit] '))
      .map(s => JSON.parse(s.replace('[audit] ', '')));
  }

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it('emits audit on successful tool call', async () => {
    const env = makeEnv();
    const sessionId = await getSession(env);
    const req = rpcRequest('tools/call', { name: 'flow.status', arguments: { flowId: 'abc' } }, { 'MCP-Session-Id': sessionId });
    await handleMcpRequest(req, env);

    const audits = getAuditLogs();
    expect(audits.length).toBe(1);
    expect(audits[0].tool).toBe('flow.status');
    expect(audits[0].risk_level).toBe('READ_ONLY');
    expect(audits[0].outcome).toBe('success');
    expect(audits[0].policy_decision).toBe('ALLOW');
    expect(audits[0].tenant).toBe('tenant-1');
    expect(audits[0].latency_ms).toBeTypeOf('number');
  });

  it('emits audit with DENY on unknown tool', async () => {
    const env = makeEnv();
    const sessionId = await getSession(env);
    const req = rpcRequest('tools/call', { name: 'evil.tool', arguments: {} }, { 'MCP-Session-Id': sessionId });
    await handleMcpRequest(req, env);

    const audits = getAuditLogs();
    expect(audits.length).toBe(1);
    expect(audits[0].tool).toBe('evil.tool');
    expect(audits[0].outcome).toBe('unknown_tool');
    expect(audits[0].policy_decision).toBe('DENY');
  });

  it('emits audit with DENY on invalid params', async () => {
    const env = makeEnv();
    const sessionId = await getSession(env);
    const req = rpcRequest('tools/call', { arguments: {} }, { 'MCP-Session-Id': sessionId });
    await handleMcpRequest(req, env);

    const audits = getAuditLogs();
    expect(audits.length).toBe(1);
    expect(audits[0].outcome).toBe('invalid_params');
    expect(audits[0].policy_decision).toBe('DENY');
  });

  it('emits audit on auth denial', async () => {
    const env = makeEnv({
      AUTH_SERVICE: {
        ...mockAuthService(),
        validateApiKey: async () => ({ valid: false, error: 'KEY_REVOKED' }),
      },
    });
    const req = rpcRequest('tools/call', { name: 'flow.status', arguments: {} });
    await handleMcpRequest(req, env);

    const audits = getAuditLogs();
    expect(audits.length).toBe(1);
    expect(audits[0].outcome).toBe('auth_denied');
    expect(audits[0].policy_decision).toBe('DENY');
    expect(audits[0].principal).toBe('unauthenticated');
  });

  it('emits audit on backend error', async () => {
    const env = makeEnv({
      STACKBILDER: {
        fetch: async () => new Response('Internal Server Error', { status: 500 }),
        connect: () => { throw new Error('not implemented'); },
      } as unknown as Fetcher,
    });
    const sessionId = await getSession(env);
    const req = rpcRequest('tools/call', { name: 'flow.create', arguments: { policy: {} } }, { 'MCP-Session-Id': sessionId });
    await handleMcpRequest(req, env);

    const audits = getAuditLogs();
    expect(audits.length).toBe(1);
    expect(audits[0].outcome).toBe('backend_error');
    expect(audits[0].tool).toBe('flow.create');
    expect(audits[0].risk_level).toBe('LOCAL_MUTATION');
  });

  it('never leaks secrets in audit logs', async () => {
    const env = makeEnv();
    const sessionId = await getSession(env);
    const req = rpcRequest(
      'tools/call',
      { name: 'image.generate', arguments: { prompt: 'a cat', api_key: 'sk-secret123', password: 'hunter2' } },
      { 'MCP-Session-Id': sessionId },
    );
    await handleMcpRequest(req, env);

    const allLogs = logSpy.mock.calls.map(c => c[0] as string).join('\n');
    expect(allLogs).not.toContain('sk-secret123');
    expect(allLogs).not.toContain('hunter2');
    expect(allLogs).not.toContain('sb_live_test123');
  });

  it('redacted_input_summary contains tool arguments without secrets', async () => {
    const env = makeEnv();
    const sessionId = await getSession(env);
    const req = rpcRequest(
      'tools/call',
      { name: 'image.generate', arguments: { prompt: 'sunset mountain', secret: 'my_secret' } },
      { 'MCP-Session-Id': sessionId },
    );
    await handleMcpRequest(req, env);

    const audits = getAuditLogs();
    expect(audits[0].redacted_input_summary).toContain('sunset mountain');
    expect(audits[0].redacted_input_summary).not.toContain('my_secret');
  });
});
