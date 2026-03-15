// ─── MCP Gateway Transport ────────────────────────────────────
// Streamable HTTP transport that handles MCP JSON-RPC messages,
// authenticates via stackbilt-auth, and routes tool calls to
// backend product workers via Service Binding fetch.

import type { GatewayEnv, AuthResult, Tier } from './types.js';
import { extractBearerToken, validateBearerToken, buildWwwAuthenticate } from './auth.js';
import { resolveRoute, getToolRiskLevel, ROUTE_TABLE } from './route-table.js';
import { toBackendToolName, buildAggregatedCatalog, validateToolArguments } from './tool-registry.js';
import { type AuditArtifact, generateTraceId, summarizeInput, emitAudit, queueAuditEvent } from './audit.js';

const MCP_PROTOCOL_VERSION = '2025-03-26';
const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;
const JSON_RPC_INTERNAL_ERROR = -32603;

// ─── Session Store (KV-backed for cross-isolate persistence) ──
interface GatewaySession {
  id: string;
  tier: Tier;
  scopes: string[];
  tenantId?: string;
  userId?: string;
  createdAt: number;
  lastActivity: number;
}

const SESSION_TTL_SECONDS = 30 * 60; // 30 minutes
const SESSION_KEY_PREFIX = 'mcp_session:';

function generateSessionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

async function getSession(kv: KVNamespace, sessionId: string): Promise<GatewaySession | null> {
  const raw = await kv.get(`${SESSION_KEY_PREFIX}${sessionId}`);
  if (!raw) return null;
  return JSON.parse(raw) as GatewaySession;
}

async function putSession(kv: KVNamespace, session: GatewaySession): Promise<void> {
  await kv.put(
    `${SESSION_KEY_PREFIX}${session.id}`,
    JSON.stringify(session),
    { expirationTtl: SESSION_TTL_SECONDS },
  );
}

async function deleteSession(kv: KVNamespace, sessionId: string): Promise<boolean> {
  const exists = await kv.get(`${SESSION_KEY_PREFIX}${sessionId}`);
  if (!exists) return false;
  await kv.delete(`${SESSION_KEY_PREFIX}${sessionId}`);
  return true;
}

// ─── Session recovery ─────────────────────────────────────────
// If a session is expired/missing but auth is valid, rebuild it
// so clients that don't handle 404 → re-initialize still work.
async function recoverSession(
  kv: KVNamespace,
  sessionId: string,
  auth: Extract<AuthResult, { authenticated: true }>,
): Promise<GatewaySession> {
  const session: GatewaySession = {
    id: sessionId,
    tier: auth.tier,
    scopes: auth.scopes,
    tenantId: auth.tenantId,
    userId: auth.userId,
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };
  await putSession(kv, session);
  console.log(`[gateway] Session auto-recovered for ${auth.userId ?? 'unknown'} (id: ${sessionId})`);
  return session;
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

// ─── Audit helper: log + queue ─────────────────────────────────
function audit(artifact: AuditArtifact, env: GatewayEnv): void {
  emitAudit(artifact);
  queueAuditEvent(env.PLATFORM_EVENTS_QUEUE, artifact);
}

// ─── Tier-based access control ─────────────────────────────────
// Restrict expensive quality tiers to users whose plan covers them.
const TIER_ALLOWED_QUALITY: Record<Tier, Set<string>> = {
  free:       new Set(['draft', 'standard']),
  hobby:      new Set(['draft', 'standard']),
  pro:        new Set(['draft', 'standard', 'premium', 'ultra', 'ultra_plus']),
  enterprise: new Set(['draft', 'standard', 'premium', 'ultra', 'ultra_plus']),
};

function enforceTierRestriction(
  toolName: string,
  args: Record<string, unknown> | undefined,
  tier: Tier,
): string | null {
  if (toolName !== 'image_generate') return null;
  const qualityTier = (args?.quality_tier as string) ?? 'standard';
  const allowed = TIER_ALLOWED_QUALITY[tier];
  if (!allowed || allowed.has(qualityTier)) return null;
  return `Quality tier "${qualityTier}" requires a Pro plan or higher. Your current plan: ${tier}. Available tiers: ${[...allowed].join(', ')}.`;
}

// ─── Proxy a tool call to a backend worker ────────────────────
async function proxyToolCall(
  env: GatewayEnv,
  gatewayToolName: string,
  args: unknown,
  session: GatewaySession,
  traceId: string,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const riskLevel = getToolRiskLevel(gatewayToolName) ?? 'UNKNOWN';
  const auditBase: Omit<AuditArtifact, 'outcome' | 'latency_ms'> = {
    trace_id: traceId,
    principal: session.userId ?? 'unknown',
    tenant: session.tenantId ?? 'unknown',
    tool: gatewayToolName,
    risk_level: riskLevel,
    policy_decision: 'ALLOW',
    redacted_input_summary: summarizeInput(args),
    timestamp: new Date().toISOString(),
  };
  const start = Date.now();

  const resolved = resolveRoute(gatewayToolName);
  if (!resolved) {
    audit({ ...auditBase, outcome: 'unknown_tool', policy_decision: 'DENY', latency_ms: Date.now() - start }, env);
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
        Accept: 'application/json, text/event-stream',
        // Pass identity context — backend trusts Service Binding
        'X-Gateway-Tenant-Id': session.tenantId ?? '',
        'X-Gateway-User-Id': session.userId ?? '',
        'X-Gateway-Tier': session.tier,
        'X-Gateway-Scopes': session.scopes.join(','),
      },
      body: JSON.stringify(rpcBody),
      signal: AbortSignal.timeout(10_000),
    }));

    if (!response.ok) {
      const text = await response.text().catch(() => 'unknown error');
      audit({ ...auditBase, outcome: 'backend_error', latency_ms: Date.now() - start }, env);
      return {
        content: [{ type: 'text', text: `Backend error (${route.product}): ${sanitizeError(text).slice(0, 500)}` }],
        isError: true,
      };
    }

    // Backend may respond with JSON or SSE (Streamable HTTP transport).
    // SSE frames look like: "event: message\ndata: {json}\n\n"
    const contentType = response.headers.get('Content-Type') ?? '';
    let body: {
      result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
      error?: { message?: string };
    };

    if (contentType.includes('text/event-stream')) {
      const raw = await response.text();
      const jsonLine = raw.split('\n').find(line => line.startsWith('data: '));
      if (!jsonLine) {
        audit({ ...auditBase, outcome: 'backend_error', latency_ms: Date.now() - start }, env);
        return {
          content: [{ type: 'text', text: `Backend returned empty SSE stream (${route.product})` }],
          isError: true,
        };
      }
      try {
        body = JSON.parse(jsonLine.slice(6));
      } catch {
        audit({ ...auditBase, outcome: 'backend_error', latency_ms: Date.now() - start }, env);
        return {
          content: [{ type: 'text', text: `Backend returned malformed SSE data (${route.product})` }],
          isError: true,
        };
      }
    } else {
      body = await response.json();
    }

    if (body.error) {
      audit({ ...auditBase, outcome: 'backend_error', latency_ms: Date.now() - start }, env);
      return {
        content: [{ type: 'text', text: `${route.product} error: ${sanitizeError(body.error.message ?? 'unknown')}` }],
        isError: true,
      };
    }

    const fallback = { content: [{ type: 'text' as const, text: 'No result from backend' }], isError: true as const };
    if (!body.result?.content) {
      audit({ ...auditBase, outcome: 'error', latency_ms: Date.now() - start }, env);
      return fallback;
    }

    // Sanitize response: strip raw prompts from metadata to prevent injection echo (#5)
    const sanitizedContent = body.result.content.map(block => {
      if (block.type === 'text' && block.text) {
        // Redact raw prompt content from structured response metadata
        let text = block.text;
        try {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === 'object') {
            delete parsed.original_prompt;
            delete parsed.final_prompt;
            delete parsed.enhancement_logic;
            text = JSON.stringify(parsed, null, 2);
          }
        } catch {
          // Not JSON — pass through
        }
        return { ...block, text };
      }
      return block;
    });

    audit({ ...auditBase, outcome: body.result.isError ? 'error' : 'success', latency_ms: Date.now() - start }, env);
    return { content: sanitizedContent, isError: body.result.isError };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      audit({ ...auditBase, outcome: 'backend_error', latency_ms: Date.now() - start }, env);
      return {
        content: [{ type: 'text', text: `Backend timeout (${route.product})` }],
        isError: true,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    audit({ ...auditBase, outcome: 'error', latency_ms: Date.now() - start }, env);
    return {
      content: [{ type: 'text', text: `Gateway proxy error: ${sanitizeError(msg)}` }],
      isError: true,
    };
  }
}

// ─── OAuth props from OAuthProvider ───────────────────────────
export interface OAuthProps {
  userId?: string;
  email?: string;
  name?: string;
}

// ─── Main request handler ─────────────────────────────────────
export async function handleMcpRequest(
  request: Request,
  env: GatewayEnv,
  oauthProps?: OAuthProps,
): Promise<Response> {
  const method = request.method.toUpperCase();

  // Health check
  if (method === 'GET' && new URL(request.url).pathname === '/health') {
    return jsonResponse({ status: 'ok', service: 'stackbilt-mcp-gateway', version: '0.1.0' });
  }

  // DELETE — session termination
  if (method === 'DELETE') {
    return handleDelete(request, env, oauthProps);
  }

  // GET — SSE stream for server-initiated messages
  if (method === 'GET') {
    return handleGet(request, env, oauthProps);
  }

  // POST — main JSON-RPC flow
  if (method === 'POST') {
    return handlePost(request, env, oauthProps);
  }

  return jsonResponse({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' }, 405);
}

// ─── Resolve auth: OAuth props (from OAuthProvider) or Bearer token (API keys/JWTs) ──
async function resolveAuth(
  request: Request,
  env: GatewayEnv,
  oauthProps?: OAuthProps,
): Promise<AuthResult> {
  // If OAuthProvider already validated the token, use its props
  if (oauthProps?.userId) {
    // Resolve tenant info from AUTH_SERVICE for proper tier/scopes
    try {
      const tenant = await env.AUTH_SERVICE.provisionTenant({
        userId: oauthProps.userId,
        source: 'oauth',
      });
      return {
        authenticated: true,
        userId: oauthProps.userId,
        tenantId: tenant.tenantId,
        tier: (tenant.tier ?? 'free') as Tier,
        scopes: ['generate', 'read'],
      };
    } catch {
      // Fallback: if tenant resolution fails, still authenticate with defaults
      return {
        authenticated: true,
        userId: oauthProps.userId,
        tier: 'free' as Tier,
        scopes: ['generate', 'read'],
      };
    }
  }

  // No OAuth props — fall back to Bearer token validation (API keys, JWTs)
  const token = extractBearerToken(request);
  if (!token) {
    return { authenticated: false, error: 'invalid_token' };
  }
  return validateBearerToken(token, env.AUTH_SERVICE);
}

// ─── POST handler ─────────────────────────────────────────────
async function handlePost(request: Request, env: GatewayEnv, oauthProps?: OAuthProps): Promise<Response> {
  // Auth
  const authResult = await resolveAuth(request, env, oauthProps);
  if (!authResult.authenticated) {
    audit({
      trace_id: generateTraceId(),
      principal: 'unauthenticated',
      tenant: 'unknown',
      tool: 'auth',
      risk_level: 'UNKNOWN',
      policy_decision: 'DENY',
      redacted_input_summary: '{}',
      outcome: 'auth_denied',
      timestamp: new Date().toISOString(),
    }, env);
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
    return handleInitialize(rpcId, params, authResult, env);
  }

  // All other methods require a session
  const sessionId = request.headers.get('MCP-Session-Id');
  if (!sessionId) {
    return rpcError(rpcId, JSON_RPC_INVALID_REQUEST, 'MCP-Session-Id header required');
  }

  let session = await getSession(env.OAUTH_KV, sessionId);
  if (!session) {
    session = await recoverSession(env.OAUTH_KV, sessionId, authResult);
  } else {
    session.lastActivity = Date.now();
    // Fire-and-forget: refresh TTL in KV
    putSession(env.OAUTH_KV, session).catch(() => {});
  }

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
    // KV handles session expiration via expirationTtl — no manual pruning needed
    const tools = buildAggregatedCatalog();
    return rpcResult(rpcId, { tools });
  }

  // ─── tools/call ─────────────────────────────────────────
  if (rpcMethod === 'tools/call') {
    const traceId = generateTraceId();

    if (!params || typeof params['name'] !== 'string') {
      audit({
        trace_id: traceId,
        principal: session.userId ?? 'unknown',
        tenant: session.tenantId ?? 'unknown',
        tool: 'unknown',
        risk_level: 'UNKNOWN',
        policy_decision: 'DENY',
        redacted_input_summary: summarizeInput(params),
        outcome: 'invalid_params',
        timestamp: new Date().toISOString(),
      }, env);
      return rpcError(rpcId, JSON_RPC_INVALID_PARAMS, 'params.name is required');
    }

    const toolName = params['name'] as string;
    const toolArgs = params['arguments'];

    // Security: validate risk level exists
    const risk = getToolRiskLevel(toolName);
    if (!risk) {
      audit({
        trace_id: traceId,
        principal: session.userId ?? 'unknown',
        tenant: session.tenantId ?? 'unknown',
        tool: toolName,
        risk_level: 'UNKNOWN',
        policy_decision: 'DENY',
        redacted_input_summary: summarizeInput(toolArgs),
        outcome: 'unknown_tool',
        timestamp: new Date().toISOString(),
      }, env);
      return rpcError(rpcId, JSON_RPC_METHOD_NOT_FOUND, `Unknown tool: ${toolName}`);
    }

    // Validate arguments are object-shaped
    const argValidation = validateToolArguments(toolArgs, { type: 'object' });
    if (!argValidation.valid) {
      audit({
        trace_id: traceId,
        principal: session.userId ?? 'unknown',
        tenant: session.tenantId ?? 'unknown',
        tool: toolName,
        risk_level: risk,
        policy_decision: 'DENY',
        redacted_input_summary: summarizeInput(toolArgs),
        outcome: 'invalid_params',
        timestamp: new Date().toISOString(),
      }, env);
      return rpcError(rpcId, JSON_RPC_INVALID_PARAMS, argValidation.message);
    }

    // Tier-based access control: restrict expensive tiers to paying users
    const tierDenied = enforceTierRestriction(toolName, toolArgs as Record<string, unknown> | undefined, session.tier);
    if (tierDenied) {
      audit({
        trace_id: traceId,
        principal: session.userId ?? 'unknown',
        tenant: session.tenantId ?? 'unknown',
        tool: toolName,
        risk_level: risk,
        policy_decision: 'DENY',
        redacted_input_summary: summarizeInput(toolArgs),
        outcome: 'tier_denied',
        timestamp: new Date().toISOString(),
      }, env);
      return rpcError(rpcId, JSON_RPC_INVALID_PARAMS, tierDenied);
    }

    const result = await proxyToolCall(env, toolName, toolArgs, session, traceId);
    return rpcResult(rpcId, result);
  }

  return rpcError(rpcId, JSON_RPC_METHOD_NOT_FOUND, `Unknown method: ${rpcMethod}`);
}

// ─── Initialize ───────────────────────────────────────────────
async function handleInitialize(
  rpcId: unknown,
  params: Record<string, unknown> | undefined,
  auth: Extract<AuthResult, { authenticated: true }>,
  env: GatewayEnv,
): Promise<Response> {
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
  await putSession(env.OAUTH_KV, session);

  // Build product availability from route table
  const products = ROUTE_TABLE.map(r => ({
    name: r.product,
    prefix: r.prefix,
    status: 'available',
  }));

  // Build tool summary with risk levels so agents know what's available
  // without needing a separate tools/list round trip
  const catalog = buildAggregatedCatalog();
  const toolSummary = catalog.map(t => ({
    name: t.name,
    riskLevel: t.annotations.riskLevel,
    readOnly: t.annotations.readOnlyHint,
  }));

  // Tier-based quota hints
  const quotaHints: Record<Tier, { credits: number; note: string }> = {
    free: { credits: 25, note: '25 credits/mo. image_generate costs 1-20 credits depending on quality tier.' },
    hobby: { credits: 65, note: '65 credits/mo. Draft + standard quality tiers.' },
    pro: { credits: 580, note: '580 credits/mo. All quality tiers available.' },
    enterprise: { credits: 2320, note: '2320 credits/mo. Priority execution.' },
  };

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
          version: '0.2.0',
          metadata: {
            products,
            toolSummary,
            session: {
              tier: session.tier,
              scopes: session.scopes,
              ttlSeconds: SESSION_TTL_SECONDS,
              quota: quotaHints[session.tier],
            },
            riskLevels: {
              READ_ONLY: 'No side effects, safe to call freely',
              LOCAL_MUTATION: 'Creates/modifies resources within Stackbilt',
              EXTERNAL_MUTATION: 'Triggers external API calls (e.g. image generation)',
              DESTRUCTIVE: 'Irreversible action — confirm before calling',
            },
          },
        },
      },
    },
    200,
    { 'MCP-Session-Id': session.id },
  );
}

// ─── GET (SSE stream for server-initiated messages) ──────────
async function handleGet(request: Request, env: GatewayEnv, oauthProps?: OAuthProps): Promise<Response> {
  const authResult = await resolveAuth(request, env, oauthProps);
  if (!authResult.authenticated) {
    return jsonResponse({ error: authResult.error }, 401, { 'WWW-Authenticate': buildWwwAuthenticate() });
  }

  // Validate session (auto-recover if expired)
  const sessionId = request.headers.get('MCP-Session-Id');
  if (!sessionId) {
    return jsonResponse({ error: 'MCP-Session-Id header required' }, 400);
  }
  let sseSession = await getSession(env.OAUTH_KV, sessionId);
  if (!sseSession) {
    sseSession = await recoverSession(env.OAUTH_KV, sessionId, authResult);
  }

  // Must accept text/event-stream
  const accept = request.headers.get('Accept') ?? '';
  if (!accept.includes('text/event-stream')) {
    return jsonResponse({ error: 'Accept header must include text/event-stream' }, 406);
  }

  // Open an SSE stream. We don't push server-initiated messages yet,
  // but the stream must stay open for the MCP transport to be valid.
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  // Send an initial comment to confirm the stream is alive
  writer.write(encoder.encode(': stream opened\n\n'));

  // Keep-alive: send a comment every 30s so proxies/browsers don't close the connection
  const keepAlive = setInterval(async () => {
    try {
      await writer.write(encoder.encode(': keep-alive\n\n'));
    } catch {
      clearInterval(keepAlive);
    }
  }, 30_000);

  // Clean up when the client disconnects
  request.signal.addEventListener('abort', () => {
    clearInterval(keepAlive);
    writer.close().catch(() => {});
  });

  return new Response(readable, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'MCP-Session-Id': sessionId,
    },
  });
}

// ─── DELETE (session termination) ─────────────────────────────
async function handleDelete(request: Request, env: GatewayEnv, oauthProps?: OAuthProps): Promise<Response> {
  const authResult = await resolveAuth(request, env, oauthProps);
  if (!authResult.authenticated) {
    return jsonResponse({ error: authResult.error }, 401);
  }

  const sessionId = request.headers.get('MCP-Session-Id');
  if (!sessionId) {
    return jsonResponse({ error: 'MCP-Session-Id header required' }, 400);
  }

  const deleted = await deleteSession(env.OAUTH_KV, sessionId);
  if (!deleted) {
    return jsonResponse({ error: 'Session not found' }, 404);
  }

  return new Response(null, { status: 200 });
}
