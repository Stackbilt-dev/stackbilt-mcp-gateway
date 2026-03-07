// ─── MCP Gateway Transport ────────────────────────────────────
// Streamable HTTP transport that handles MCP JSON-RPC messages,
// authenticates via stackbilt-auth, and routes tool calls to
// backend product workers via Service Binding fetch.

import type { GatewayEnv, AuthResult, Tier } from './types.js';
import { extractBearerToken, validateBearerToken, buildWwwAuthenticate } from './auth.js';
import { resolveRoute, getToolRiskLevel } from './route-table.js';
import { toBackendToolName, buildAggregatedCatalog, validateToolArguments } from './tool-registry.js';

const MCP_PROTOCOL_VERSION = '2025-03-26';
const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;
const JSON_RPC_INTERNAL_ERROR = -32603;

// ─── Session Store ────────────────────────────────────────────
interface GatewaySession {
  id: string;
  tier: Tier;
  scopes: string[];
  tenantId?: string;
  userId?: string;
  createdAt: number;
  lastActivity: number;
}

const sessions = new Map<string, GatewaySession>();
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

function generateSessionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function pruneExpiredSessions(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActivity > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}

// ─── JSON helpers ─────────────────────────────────────────────
function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function rpcError(id: unknown, code: number, message: string): Response {
  return jsonResponse({
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message },
  });
}

function rpcResult(id: unknown, result: unknown): Response {
  return jsonResponse({
    jsonrpc: '2.0',
    id,
    result,
  });
}

// ─── Security: scrub secrets from error messages ──────────────
function sanitizeError(message: string): string {
  // Strip anything that looks like a token, key, or secret
  return message
    .replace(/sb_(live|test)_[a-zA-Z0-9]+/g, '[REDACTED_KEY]')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
    .replace(/[a-f0-9]{32,}/gi, '[REDACTED_HASH]');
}

// ─── Proxy a tool call to a backend worker ────────────────────
async function proxyToolCall(
  env: GatewayEnv,
  gatewayToolName: string,
  args: unknown,
  session: GatewaySession,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const resolved = resolveRoute(gatewayToolName);
  if (!resolved) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${gatewayToolName}` }],
      isError: true,
    };
  }

  const { route } = resolved;
  const backendToolName = toBackendToolName(gatewayToolName);
  const binding = env[route.bindingKey] as Fetcher;

  // Build JSON-RPC request to forward to the backend
  const rpcBody = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: backendToolName,
      arguments: args ?? {},
    },
  };

  try {
    const response = await binding.fetch(new Request(`https://internal${route.mcpPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        // Pass identity context — backend trusts Service Binding
        'X-Gateway-Tenant-Id': session.tenantId ?? '',
        'X-Gateway-User-Id': session.userId ?? '',
        'X-Gateway-Tier': session.tier,
        'X-Gateway-Scopes': session.scopes.join(','),
      },
      body: JSON.stringify(rpcBody),
    }));

    if (!response.ok) {
      const text = await response.text().catch(() => 'unknown error');
      return {
        content: [{ type: 'text', text: `Backend error (${route.product}): ${sanitizeError(text).slice(0, 500)}` }],
        isError: true,
      };
    }

    const body = await response.json() as {
      result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
      error?: { message?: string };
    };

    if (body.error) {
      return {
        content: [{ type: 'text', text: `${route.product} error: ${sanitizeError(body.error.message ?? 'unknown')}` }],
        isError: true,
      };
    }

    const fallback = { content: [{ type: 'text' as const, text: 'No result from backend' }], isError: true as const };
    if (!body.result?.content) return fallback;
    return { content: body.result.content, isError: body.result.isError };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `Gateway proxy error: ${sanitizeError(msg)}` }],
      isError: true,
    };
  }
}

// ─── Main request handler ─────────────────────────────────────
export async function handleMcpRequest(
  request: Request,
  env: GatewayEnv,
): Promise<Response> {
  const method = request.method.toUpperCase();

  // Health check
  if (method === 'GET' && new URL(request.url).pathname === '/health') {
    return jsonResponse({ status: 'ok', service: 'stackbilt-mcp-gateway', version: '0.1.0' });
  }

  // DELETE — session termination
  if (method === 'DELETE') {
    return handleDelete(request, env);
  }

  // GET — SSE streams (not supported in Phase 1)
  if (method === 'GET') {
    return handleGet(request, env);
  }

  // POST — main JSON-RPC flow
  if (method === 'POST') {
    return handlePost(request, env);
  }

  return jsonResponse({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' }, 405);
}

// ─── POST handler ─────────────────────────────────────────────
async function handlePost(request: Request, env: GatewayEnv): Promise<Response> {
  // Auth
  const token = extractBearerToken(request);
  if (!token) {
    return jsonResponse(
      { error: 'Authentication required', code: 'MISSING_AUTH' },
      401,
      { 'WWW-Authenticate': buildWwwAuthenticate() },
    );
  }

  const authResult = await validateBearerToken(token, env.AUTH_SERVICE);
  if (!authResult.authenticated) {
    const status = authResult.error === 'insufficient_scope' ? 403 : 401;
    return jsonResponse(
      { error: authResult.error, code: authResult.error.toUpperCase() },
      status,
      { 'WWW-Authenticate': buildWwwAuthenticate(authResult.error) },
    );
  }

  // Validate Accept header
  const accept = request.headers.get('Accept') ?? '';
  if (!accept.includes('application/json') && !accept.includes('*/*') && accept !== '') {
    return jsonResponse({ error: 'Accept header must include application/json' }, 400);
  }

  // Parse body
  let msg: Record<string, unknown>;
  try {
    msg = await request.json() as Record<string, unknown>;
  } catch {
    return rpcError(null, JSON_RPC_PARSE_ERROR, 'Parse error');
  }

  if (typeof msg !== 'object' || msg === null || msg['jsonrpc'] !== '2.0') {
    return rpcError(msg?.['id'], JSON_RPC_INVALID_REQUEST, 'Invalid JSON-RPC request');
  }

  const rpcMethod = msg['method'] as string | undefined;
  const rpcId = msg['id'];
  const params = msg['params'] as Record<string, unknown> | undefined;

  // ─── initialize ─────────────────────────────────────────
  if (rpcMethod === 'initialize') {
    return handleInitialize(rpcId, params, authResult);
  }

  // All other methods require a session
  const sessionId = request.headers.get('MCP-Session-Id');
  if (!sessionId) {
    return rpcError(rpcId, JSON_RPC_INVALID_REQUEST, 'MCP-Session-Id header required');
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return jsonResponse(
      { error: 'Session expired or unknown. Re-initialize.', code: 'SESSION_EXPIRED' },
      404,
    );
  }
  session.lastActivity = Date.now();

  // ─── notifications (fire-and-forget) ────────────────────
  if (rpcMethod === 'notifications/initialized') {
    return new Response(null, { status: 202 });
  }

  // ─── ping ───────────────────────────────────────────────
  if (rpcMethod === 'ping') {
    return rpcResult(rpcId, {});
  }

  // ─── tools/list ─────────────────────────────────────────
  if (rpcMethod === 'tools/list') {
    pruneExpiredSessions();
    const tools = buildAggregatedCatalog();
    return rpcResult(rpcId, { tools });
  }

  // ─── tools/call ─────────────────────────────────────────
  if (rpcMethod === 'tools/call') {
    if (!params || typeof params['name'] !== 'string') {
      return rpcError(rpcId, JSON_RPC_INVALID_PARAMS, 'params.name is required');
    }

    const toolName = params['name'] as string;
    const toolArgs = params['arguments'];

    // Security: validate risk level exists
    const risk = getToolRiskLevel(toolName);
    if (!risk) {
      return rpcError(rpcId, JSON_RPC_METHOD_NOT_FOUND, `Unknown tool: ${toolName}`);
    }

    // Validate arguments are object-shaped
    const argValidation = validateToolArguments(toolArgs, { type: 'object' });
    if (!argValidation.valid) {
      return rpcError(rpcId, JSON_RPC_INVALID_PARAMS, argValidation.message);
    }

    const result = await proxyToolCall(env, toolName, toolArgs, session);
    return rpcResult(rpcId, result);
  }

  return rpcError(rpcId, JSON_RPC_METHOD_NOT_FOUND, `Unknown method: ${rpcMethod}`);
}

// ─── Initialize ───────────────────────────────────────────────
function handleInitialize(
  rpcId: unknown,
  params: Record<string, unknown> | undefined,
  auth: Extract<AuthResult, { authenticated: true }>,
): Response {
  const clientInfo = params?.['clientInfo'] as Record<string, unknown> | undefined;
  const protocolVersion = params?.['protocolVersion'] as string | undefined;

  if (protocolVersion && protocolVersion !== MCP_PROTOCOL_VERSION) {
    // Accept anyway — we're forward-compatible
  }

  const session: GatewaySession = {
    id: generateSessionId(),
    tier: auth.tier,
    scopes: auth.scopes,
    tenantId: auth.tenantId,
    userId: auth.userId,
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };
  sessions.set(session.id, session);

  return jsonResponse(
    {
      jsonrpc: '2.0',
      id: rpcId,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: {
          name: 'stackbilt-mcp-gateway',
          version: '0.1.0',
        },
      },
    },
    200,
    { 'MCP-Session-Id': session.id },
  );
}

// ─── GET (SSE — Phase 1: not supported) ──────────────────────
async function handleGet(request: Request, env: GatewayEnv): Promise<Response> {
  const token = extractBearerToken(request);
  if (!token) {
    return jsonResponse(
      { error: 'Authentication required' },
      401,
      { 'WWW-Authenticate': buildWwwAuthenticate() },
    );
  }

  const authResult = await validateBearerToken(token, env.AUTH_SERVICE);
  if (!authResult.authenticated) {
    return jsonResponse({ error: authResult.error }, 401, { 'WWW-Authenticate': buildWwwAuthenticate() });
  }

  return jsonResponse({ error: 'Server-initiated streams not supported in Phase 1' }, 405);
}

// ─── DELETE (session termination) ─────────────────────────────
async function handleDelete(request: Request, env: GatewayEnv): Promise<Response> {
  const token = extractBearerToken(request);
  if (!token) {
    return jsonResponse({ error: 'Authentication required' }, 401, { 'WWW-Authenticate': buildWwwAuthenticate() });
  }

  const authResult = await validateBearerToken(token, env.AUTH_SERVICE);
  if (!authResult.authenticated) {
    return jsonResponse({ error: authResult.error }, 401);
  }

  const sessionId = request.headers.get('MCP-Session-Id');
  if (!sessionId) {
    return jsonResponse({ error: 'MCP-Session-Id header required' }, 400);
  }

  if (!sessions.delete(sessionId)) {
    return jsonResponse({ error: 'Session not found' }, 404);
  }

  return new Response(null, { status: 200 });
}
