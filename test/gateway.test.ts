import { describe, it, expect, beforeEach } from 'vitest';
import { handleMcpRequest } from '../src/gateway.js';
import type { GatewayEnv, AuthServiceRpc } from '../src/types.js';

// ─── Mocks ────────────────────────────────────────────────────
function mockAuthService(tier: string = 'pro'): AuthServiceRpc {
  return {
    validateApiKey: async () => ({ valid: true, tenant_id: 'tenant-1', tier, scopes: ['generate', 'read'] }),
    validateJwt: async () => ({ valid: true, tenant_id: 'tenant-1', user_id: 'user-1', tier, scopes: ['read'] }),
    authenticateUser: async () => ({ valid: false }),
    registerUser: async () => ({ valid: false }),
    provisionTenant: async () => ({ tenantId: '', userId: '', tier: 'free', delinquent: false, createdAt: '' }),
    exchangeSocialCode: async () => ({ valid: false }),
  };
}

function mockFetcher(responseBody: unknown = {}, status = 200): Fetcher {
  return {
    fetch: async () => new Response(JSON.stringify(responseBody), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
    connect: () => { throw new Error('not implemented'); },
  } as unknown as Fetcher;
}

function makeEnv(overrides?: Partial<GatewayEnv>): GatewayEnv {
  return {
    AUTH_SERVICE: mockAuthService(),
    STACKBILDER: mockFetcher({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'flow created' }] } }),
    IMG_FORGE: mockFetcher({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'image generated' }] } }),
    OAUTH_PROVIDER: {} as any,
    OAUTH_KV: {} as any,
    PLATFORM_EVENTS_QUEUE: { send: async () => {} } as unknown as Queue,
    SERVICE_BINDING_SECRET: 'test-secret',
    API_BASE_URL: 'https://mcp.stackbilt.dev',
    ...overrides,
  };
}

function rpcRequest(
  method: string,
  params?: unknown,
  headers?: Record<string, string>,
): Request {
  return new Request('https://mcp.stackbilt.dev/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: 'Bearer sb_live_test123',
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    }),
  });
}

// ─── Tests ────────────────────────────────────────────────────
describe('handleMcpRequest', () => {
  describe('health', () => {
    it('returns 200 on GET /health', async () => {
      const req = new Request('https://mcp.stackbilt.dev/health', { method: 'GET' });
      const res = await handleMcpRequest(req, makeEnv());
      expect(res.status).toBe(200);
      const body = await res.json() as { status: string };
      expect(body.status).toBe('ok');
    });
  });

  describe('auth enforcement', () => {
    it('returns 401 without Authorization header', async () => {
      const req = new Request('https://mcp.stackbilt.dev/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
      const res = await handleMcpRequest(req, makeEnv());
      expect(res.status).toBe(401);
      expect(res.headers.get('WWW-Authenticate')).toBeTruthy();
    });

    it('returns 401 for invalid token', async () => {
      const env = makeEnv({
        AUTH_SERVICE: {
          ...mockAuthService(),
          validateApiKey: async () => ({ valid: false, error: 'KEY_REVOKED' }),
        },
      });
      const req = rpcRequest('ping');
      const res = await handleMcpRequest(req, env);
      expect(res.status).toBe(401);
    });
  });

  describe('initialize', () => {
    it('creates session and returns protocol version', async () => {
      const req = rpcRequest('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0' },
      });
      const res = await handleMcpRequest(req, makeEnv());
      expect(res.status).toBe(200);
      expect(res.headers.get('MCP-Session-Id')).toBeTruthy();

      const body = await res.json() as any;
      expect(body.result.protocolVersion).toBe('2025-03-26');
      expect(body.result.serverInfo.name).toBe('stackbilt-mcp-gateway');
      expect(body.result.capabilities.tools).toBeTruthy();
    });
  });

  describe('session management', () => {
    it('requires MCP-Session-Id for non-initialize methods', async () => {
      const req = rpcRequest('tools/list');
      const res = await handleMcpRequest(req, makeEnv());
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.error.code).toBe(-32600); // INVALID_REQUEST
    });

    it('returns 404 for unknown session ID', async () => {
      const req = rpcRequest('tools/list', undefined, { 'MCP-Session-Id': 'nonexistent' });
      const res = await handleMcpRequest(req, makeEnv());
      expect(res.status).toBe(404);
    });
  });

  describe('tools/list', () => {
    it('returns aggregated tool catalog', async () => {
      const env = makeEnv();

      // Initialize first to get a session
      const initReq = rpcRequest('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test' } });
      const initRes = await handleMcpRequest(initReq, env);
      const sessionId = initRes.headers.get('MCP-Session-Id')!;

      // List tools
      const listReq = rpcRequest('tools/list', undefined, { 'MCP-Session-Id': sessionId });
      const listRes = await handleMcpRequest(listReq, env);
      expect(listRes.status).toBe(200);

      const body = await listRes.json() as any;
      const tools = body.result.tools as Array<{ name: string; annotations: { riskLevel: string } }>;
      expect(tools.length).toBe(10);

      // Verify risk levels present on all tools
      for (const tool of tools) {
        expect(tool.annotations.riskLevel, `${tool.name} missing riskLevel`).toBeTruthy();
      }

      // Check specific tools exist
      const names = tools.map(t => t.name);
      expect(names).toContain('flow.create');
      expect(names).toContain('flow.status');
      expect(names).toContain('image.generate');
      expect(names).toContain('image.list_models');
    });
  });

  describe('tools/call routing', () => {
    async function getSession(env: GatewayEnv): Promise<string> {
      const initReq = rpcRequest('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test' } });
      const initRes = await handleMcpRequest(initReq, env);
      return initRes.headers.get('MCP-Session-Id')!;
    }

    it('routes flow.create to STACKBILDER binding', async () => {
      let capturedUrl = '';
      const env = makeEnv({
        STACKBILDER: {
          fetch: async (input: RequestInfo) => {
            const req = input as Request;
            capturedUrl = req.url;
            return new Response(JSON.stringify({
              jsonrpc: '2.0', id: 1,
              result: { content: [{ type: 'text', text: 'created' }] },
            }), { headers: { 'Content-Type': 'application/json' } });
          },
          connect: () => { throw new Error('not implemented'); },
        } as unknown as Fetcher,
      });

      const sessionId = await getSession(env);
      const req = rpcRequest('tools/call', { name: 'flow.create', arguments: { policy: {} } }, { 'MCP-Session-Id': sessionId });
      const res = await handleMcpRequest(req, env);
      expect(res.status).toBe(200);

      const body = await res.json() as any;
      expect(body.result.content[0].text).toBe('created');
      expect(capturedUrl).toContain('/mcp');
    });

    it('routes image.generate to IMG_FORGE binding', async () => {
      let capturedBody: any = null;
      const env = makeEnv({
        IMG_FORGE: {
          fetch: async (input: RequestInfo) => {
            const req = input as Request;
            capturedBody = await req.json();
            return new Response(JSON.stringify({
              jsonrpc: '2.0', id: 1,
              result: { content: [{ type: 'text', text: 'generated' }] },
            }), { headers: { 'Content-Type': 'application/json' } });
          },
          connect: () => { throw new Error('not implemented'); },
        } as unknown as Fetcher,
      });

      const sessionId = await getSession(env);
      const req = rpcRequest('tools/call', { name: 'image.generate', arguments: { prompt: 'a cat' } }, { 'MCP-Session-Id': sessionId });
      const res = await handleMcpRequest(req, env);
      expect(res.status).toBe(200);

      // Verify the backend receives the native tool name
      expect(capturedBody.params.name).toBe('generate_image');
    });

    it('rejects unknown tool names', async () => {
      const env = makeEnv();
      const sessionId = await getSession(env);
      const req = rpcRequest('tools/call', { name: 'unknown.tool', arguments: {} }, { 'MCP-Session-Id': sessionId });
      const res = await handleMcpRequest(req, env);
      expect(res.status).toBe(200);

      const body = await res.json() as any;
      expect(body.error.code).toBe(-32601); // METHOD_NOT_FOUND
    });

    it('rejects tool call without name param', async () => {
      const env = makeEnv();
      const sessionId = await getSession(env);
      const req = rpcRequest('tools/call', { arguments: {} }, { 'MCP-Session-Id': sessionId });
      const res = await handleMcpRequest(req, env);
      const body = await res.json() as any;
      expect(body.error.code).toBe(-32602); // INVALID_PARAMS
    });

    it('passes identity headers to backend', async () => {
      let capturedHeaders: Record<string, string> = {};
      const env = makeEnv({
        STACKBILDER: {
          fetch: async (input: RequestInfo) => {
            const req = input as Request;
            capturedHeaders = {
              tenantId: req.headers.get('X-Gateway-Tenant-Id') ?? '',
              tier: req.headers.get('X-Gateway-Tier') ?? '',
            };
            return new Response(JSON.stringify({
              jsonrpc: '2.0', id: 1,
              result: { content: [{ type: 'text', text: 'ok' }] },
            }), { headers: { 'Content-Type': 'application/json' } });
          },
          connect: () => { throw new Error('not implemented'); },
        } as unknown as Fetcher,
      });

      const sessionId = await getSession(env);
      const req = rpcRequest('tools/call', { name: 'flow.status', arguments: { flowId: 'abc' } }, { 'MCP-Session-Id': sessionId });
      await handleMcpRequest(req, env);

      expect(capturedHeaders.tenantId).toBe('tenant-1');
      expect(capturedHeaders.tier).toBe('pro');
    });
  });

  describe('security', () => {
    it('does not leak secrets in error messages', async () => {
      const env = makeEnv({
        STACKBILDER: {
          fetch: async () => new Response('sb_live_secret_key_leaked', { status: 500 }),
          connect: () => { throw new Error('not implemented'); },
        } as unknown as Fetcher,
      });

      const initReq = rpcRequest('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test' } });
      const initRes = await handleMcpRequest(initReq, env);
      const sessionId = initRes.headers.get('MCP-Session-Id')!;

      const req = rpcRequest('tools/call', { name: 'flow.create', arguments: { policy: {} } }, { 'MCP-Session-Id': sessionId });
      const res = await handleMcpRequest(req, env);
      const body = await res.json() as any;

      const text = JSON.stringify(body);
      expect(text).not.toContain('sb_live_secret_key_leaked');
      expect(text).toContain('[REDACTED_KEY]');
    });

    it('notifications return 202', async () => {
      const env = makeEnv();
      const initReq = rpcRequest('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test' } });
      const initRes = await handleMcpRequest(initReq, env);
      const sessionId = initRes.headers.get('MCP-Session-Id')!;

      const req = rpcRequest('notifications/initialized', undefined, { 'MCP-Session-Id': sessionId });
      const res = await handleMcpRequest(req, env);
      expect(res.status).toBe(202);
    });
  });

  describe('DELETE session', () => {
    it('terminates an active session', async () => {
      const env = makeEnv();
      const initReq = rpcRequest('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test' } });
      const initRes = await handleMcpRequest(initReq, env);
      const sessionId = initRes.headers.get('MCP-Session-Id')!;

      const deleteReq = new Request('https://mcp.stackbilt.dev/mcp', {
        method: 'DELETE',
        headers: {
          Authorization: 'Bearer sb_live_test123',
          'MCP-Session-Id': sessionId,
        },
      });
      const deleteRes = await handleMcpRequest(deleteReq, env);
      expect(deleteRes.status).toBe(200);

      // Session should be gone now
      const listReq = rpcRequest('tools/list', undefined, { 'MCP-Session-Id': sessionId });
      const listRes = await handleMcpRequest(listReq, env);
      expect(listRes.status).toBe(404);
    });
  });
});
