// ─── MCP Gateway Transport ────────────────────────────────────
// Streamable HTTP transport that handles MCP JSON-RPC messages,
// authenticates via stackbilt-auth, and routes tool calls to
// backend product workers via Service Binding fetch.

import type { GatewayEnv, AuthResult, Tier } from './types.js';
import { extractBearerToken, validateBearerToken, buildWwwAuthenticate } from './auth.js';
import { resolveRoute, getToolRiskLevel, ROUTE_TABLE, type BackendRoute } from './route-table.js';
import { toBackendToolName, buildAggregatedCatalog, validateToolArguments } from './tool-registry.js';
import { type AuditArtifact, generateTraceId, summarizeInput, emitAudit, queueAuditEvent } from './audit.js';
import { materializeScaffold } from './scaffold-materializer.js';
import { publishToGitHub } from './scaffold-publish.js';
import { classifyIntention, type IntentClassification } from './intent-classifier.js';
import { logDivergence } from './divergence-logger.js';

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

// ─── TarotScript REST API translation ─────────────────────────
// Translates MCP tool calls into TarotScript POST /run requests.
// Each scaffold_* tool maps to a specific spreadType + querent config.

async function proxyRestToolCall(
  binding: Fetcher,
  route: BackendRoute,
  toolName: string,
  args: unknown,
  session: GatewaySession,
  env: GatewayEnv,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const a = (args ?? {}) as Record<string, unknown>;

  if (toolName === 'scaffold_status') {
    // Health check — GET /health + GET /spreads
    const [healthRes, spreadsRes] = await Promise.all([
      binding.fetch('https://internal/health'),
      binding.fetch('https://internal/spreads'),
    ]);
    const health = await healthRes.json() as Record<string, unknown>;
    const spreads = await spreadsRes.json() as Record<string, unknown>;
    return {
      content: [{ type: 'text', text: JSON.stringify({ health, spreads }, null, 2) }],
    };
  }

  if (toolName === 'scaffold_classify') {
    const response = await binding.fetch(new Request('https://internal/run', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Gateway-Tenant-Id': session.tenantId ?? '',
      },
      body: JSON.stringify({
        spreadType: 'classify-cast',
        querent: {
          id: session.tenantId ?? session.userId ?? 'gateway',
          intention: a.message as string,
          state: {
            message: a.message as string,
            source: (a.source as string) ?? 'user',
          },
        },
      }),
    }));

    if (!response.ok) {
      const err = await response.text().catch(() => `HTTP ${response.status}`);
      return { content: [{ type: 'text', text: `classify-cast failed: ${err}` }], isError: true };
    }

    const result = await response.json() as { facts?: Record<string, string>; output?: string[] };
    return {
      content: [{ type: 'text', text: JSON.stringify({
        classification: result.facts?.classification,
        confidence: result.facts?.classification_confidence,
        executor: result.facts?.classification_executor,
        complexity: result.facts?.classification_complexity,
        secondary: result.facts?.secondary_classification,
        compound_intent: result.facts?.compound_intent,
        tiebreaker_override: result.facts?.tiebreaker_override,
      }, null, 2) }],
    };
  }

  if (toolName === 'scaffold_create') {
    const intention = a.intention as string;
    const state: Record<string, string> = {
      project_type: (a.project_type as string) ?? 'saas',
      complexity: (a.complexity as string) ?? 'moderate',
    };
    if (a.modes) state.modes = (a.modes as string[]).join(',');

    const response = await binding.fetch(new Request('https://internal/run', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Gateway-Tenant-Id': session.tenantId ?? '',
      },
      body: JSON.stringify({
        spreadType: 'scaffold-cast',
        querent: {
          id: session.tenantId ?? session.userId ?? 'gateway',
          intention,
          state,
        },
        inscribe: true,
      }),
      signal: AbortSignal.timeout(30_000),
    }));

    if (!response.ok) {
      const err = await response.text().catch(() => `HTTP ${response.status}`);
      return { content: [{ type: 'text', text: `scaffold-cast failed: ${err}` }], isError: true };
    }

    const result = await response.json() as {
      output?: string[];
      facts?: Record<string, unknown>;
      receipt?: { hash: string; seed: number };
      analysis?: Record<string, unknown>;
    };

    // Materialize project files — three-tier input resolution:
    //   Tier 1: Explicit params from caller (pattern, routes, integrations)
    //   Tier 2: LLM classification of free text (this block)
    //   Tier 3: Regex fallback in engine's parsePRD
    let files: Array<{ path: string; content: string }> | undefined;
    let nextSteps: string[] | undefined;
    let fileSource: 'engine' | 'basic' | 'none' = 'none';

    // Three-tier scaffold resolution:
    //   Tier 1: Explicit params from caller (pattern, routes, integrations)
    //   Tier 2: Cerebras LLM classification (~100ms, $0.0002/call)
    //   Tier 3: Regex in engine parsePRD (0ms, $0)
    //
    // Optimization: call engine first (Tier 3, ~150ms). If parser_confidence >= 0.75,
    // skip Tier 2 entirely. If low confidence, call Cerebras and re-call engine with
    // classified fields. This cuts ~30% of LLM calls for well-matched patterns.

    const hasExplicitParams = a.pattern || a.routes || a.integrations;
    let classification: IntentClassification | null = null;
    const CONFIDENCE_THRESHOLD = 0.75;

    if (env.ENGINE) {
      try {
        const engineTier = session.tier === 'pro' || session.tier === 'enterprise' ? 'all' : 'blessed';

        // Step 1: Call engine with Tier 1 explicit params only (Tier 3 regex runs inside)
        const baseReq: Record<string, unknown> = { description: intention, tier: engineTier };
        if (a.pattern) baseReq.pattern = a.pattern;
        if (a.routes) baseReq.routes = a.routes;
        if (a.integrations) baseReq.integrations = a.integrations;

        const baseRes = await env.ENGINE.fetch(new Request('https://engine/scaffold', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(baseReq),
          signal: AbortSignal.timeout(10_000),
        }));

        if (baseRes.ok) {
          const engineData = await baseRes.json() as {
            files?: Array<{ path: string; content: string }>;
            project_name?: string;
            pattern?: string;
            routes?: string[];
            integrations?: string[];
            parser_confidence?: number;
          };

          const parserConfidence = engineData.parser_confidence ?? 0;
          const needsTier2 = !hasExplicitParams && parserConfidence < CONFIDENCE_THRESHOLD && env.CEREBRAS_API_KEY;

          if (needsTier2) {
            // Step 2: Tier 3 not confident — call Cerebras for LLM classification
            try {
              classification = await classifyIntention(intention, env.CEREBRAS_API_KEY!);
            } catch {
              // Cerebras unavailable — use Tier 3 output as-is
            }

            if (classification) {
              // Step 3: Re-call engine with Tier 2 classified fields
              const enrichedReq: Record<string, unknown> = { ...baseReq };
              if (!enrichedReq.pattern && classification.pattern) enrichedReq.pattern = classification.pattern;
              if (!enrichedReq.routes && classification.routes?.length) enrichedReq.routes = classification.routes;
              if (!enrichedReq.integrations && classification.integrations?.length) enrichedReq.integrations = classification.integrations;
              if (classification.projectName) enrichedReq.project_name = classification.projectName;
              if (classification.entities?.length) enrichedReq.entities = classification.entities;
              if (classification.constraints) enrichedReq.constraints = classification.constraints;

              const enrichedRes = await env.ENGINE.fetch(new Request('https://engine/scaffold', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(enrichedReq),
                signal: AbortSignal.timeout(10_000),
              }));

              if (enrichedRes.ok) {
                const enrichedData = await enrichedRes.json() as typeof engineData;
                // Use enriched result instead
                Object.assign(engineData, enrichedData);
              }

              if (result.facts) {
                result.facts.classification_confidence = classification.confidence;
                result.facts.tier2_invoked = true;
                if (classification.ambiguous?.length) {
                  result.facts.classification_ambiguous = classification.ambiguous;
                }
              }
            }
          } else if (result.facts) {
            result.facts.tier2_invoked = false;
            result.facts.tier2_skip_reason = parserConfidence >= CONFIDENCE_THRESHOLD
              ? `parser_confidence ${parserConfidence} >= ${CONFIDENCE_THRESHOLD}`
              : 'explicit_params';
          }

          // Materialize files from final engine result
          if (engineData.files && engineData.files.length > 0) {
            files = engineData.files;
            fileSource = 'engine';
            if (result.facts) {
              if (engineData.pattern) result.facts.engine_pattern = engineData.pattern;
              if (engineData.routes?.length) result.facts.engine_routes = engineData.routes;
              if (engineData.integrations?.length) result.facts.engine_integrations = engineData.integrations;
              if (engineData.project_name) result.facts.engine_project_name = engineData.project_name;
              if (engineData.parser_confidence != null) result.facts.parser_confidence = engineData.parser_confidence;
            }

            // Log divergence for pattern mining (#102)
            if (classification && env.OAUTH_KV) {
              logDivergence(env.OAUTH_KV, intention, classification, engineData);
            }
          }
        } else {
          const errText = await baseRes.text().catch(() => '');
          console.error(`ENGINE /scaffold failed: ${baseRes.status} ${errText}`);
        }
      } catch (engineErr) {
        console.error('ENGINE /scaffold error:', engineErr);
      }
    }

    // Merge governance files from materializer with engine code files,
    // or fall back to materializer entirely if engine didn't produce files
    if (result.facts) {
      try {
        const materialized = materializeScaffold(result.facts, intention);
        if (!files) {
          // Engine didn't produce files — use materializer output entirely
          files = materialized.files;
          nextSteps = materialized.nextSteps;
          fileSource = 'basic';
        } else {
          // Engine produced code files — merge in governance (.ai/) files from materializer
          const enginePaths = new Set(files.map(f => f.path));
          const govFiles = materialized.files.filter(f => f.path.startsWith('.ai/') && !enginePaths.has(f.path));
          if (govFiles.length > 0) {
            files = [...files, ...govFiles];
          }
          nextSteps = materialized.nextSteps;
        }
      } catch {
        // Materializer failure is non-fatal — return facts without files
      }
    }

    // Default next steps if engine produced files but no steps
    if (files && !nextSteps) {
      const projectName = files.find(f => f.path === 'package.json')
        ? JSON.parse(files.find(f => f.path === 'package.json')!.content).name
        : 'my-project';
      nextSteps = [
        'npm install',
        `npx wrangler d1 create ${projectName}  # if D1 binding needed`,
        'npx wrangler deploy',
      ];
    }

    return {
      content: [{ type: 'text', text: JSON.stringify({
        output: result.output,
        facts: result.facts,
        files,
        fileSource,
        nextSteps,
        receipt: result.receipt,
        analysis: result.analysis,
      }, null, 2) }],
    };
  }

  if (toolName === 'scaffold_publish') {
    const repoName = a.repo_name as string;
    const owner = (a.owner as string) ?? 'Stackbilt-dev';
    const filesJson = a.files as Array<{ path: string; content: string }> | undefined;
    const githubToken = (a.github_token as string) ?? env.GITHUB_TOKEN;

    if (!githubToken) {
      return { content: [{ type: 'text', text: 'No GitHub token provided. Pass github_token parameter or set GITHUB_TOKEN secret.' }], isError: true };
    }

    if (!filesJson || filesJson.length === 0) {
      return { content: [{ type: 'text', text: 'No files provided. Run scaffold_create first to generate files[].' }], isError: true };
    }

    try {
      const result = await publishToGitHub(githubToken, {
        repo_name: repoName,
        owner,
        files: filesJson,
        private: (a.private as boolean) ?? true,
        description: a.description as string | undefined,
        commit_message: a.commit_message as string | undefined,
      });

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `scaffold_publish failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }

  if (toolName === 'scaffold_deploy') {
    if (!env.DEPLOYER) {
      return { content: [{ type: 'text', text: 'Deployer service not configured' }], isError: true };
    }

    const body = {
      cf_api_token: a.cf_api_token as string,
      cf_account_id: a.cf_account_id as string,
      worker_name: a.worker_name as string,
      script: a.script as string,
      compatibility_date: a.compatibility_date as string | undefined,
      compatibility_flags: a.compatibility_flags as string[] | undefined,
      bindings: a.bindings as Array<Record<string, unknown>> | undefined,
    };

    try {
      const res = await env.DEPLOYER.fetch(new Request('https://internal/deploy/worker', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Gateway-Tenant-Id': session.tenantId ?? '',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      }));

      const data = await res.json() as Record<string, unknown>;
      return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        isError: !res.ok,
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Deploy failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }

  // ── Visual QA tools ────────────────────────────────────────────

  if (toolName === 'visual_screenshot' || toolName === 'visual_analyze' || toolName === 'visual_pages') {
    const vqaBinding = env.VISUAL_QA;
    if (!vqaBinding) {
      return { content: [{ type: 'text', text: 'Visual QA service not configured' }], isError: true };
    }

    // Map tool name to endpoint
    const endpointMap: Record<string, { path: string; method: string }> = {
      visual_screenshot: { path: '/upload', method: 'POST' },
      visual_analyze: { path: '/analyze', method: 'POST' },
      visual_pages: { path: '/pages', method: 'GET' },
    };

    const endpoint = endpointMap[toolName];
    if (!endpoint) {
      return { content: [{ type: 'text', text: `Unknown visual tool: ${toolName}` }], isError: true };
    }

    try {
      const fetchInit: RequestInit = {
        method: endpoint.method,
        headers: {
          'Content-Type': 'application/json',
          'X-Gateway-Tenant-Id': session.tenantId ?? '',
        },
        signal: AbortSignal.timeout(60_000),
      };

      if (endpoint.method === 'POST') {
        fetchInit.body = JSON.stringify(a);
      }

      const res = await vqaBinding.fetch(
        new Request(`https://internal${endpoint.path}`, fetchInit),
      );

      const data = await res.json();
      return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        isError: !res.ok,
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Visual QA error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }

  // ── n8n Transpiler ──────────────────────────────────────────────

  if (toolName === 'scaffold_import') {
    const transpiler = env.TRANSPILER;
    if (!transpiler) {
      return { content: [{ type: 'text', text: 'n8n transpiler service not configured' }], isError: true };
    }

    try {
      const res = await transpiler.fetch(new Request('https://internal/transpile', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Gateway-Tenant-Id': session.tenantId ?? '',
        },
        body: JSON.stringify({
          workflow: a.workflow,
          project_name: a.project_name,
        }),
        signal: AbortSignal.timeout(30_000),
      }));

      const data = await res.json();
      return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        isError: !res.ok,
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Transpiler error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }

  return {
    content: [{ type: 'text', text: `Unknown REST tool: ${toolName}` }],
    isError: true,
  };
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

  // ── REST API backends (e.g. TarotScript) ──────────────────────
  if (route.restApi) {
    try {
      const result = await proxyRestToolCall(binding, route, backendToolName, args, session, env);
      audit({ ...auditBase, outcome: 'success', latency_ms: Date.now() - start }, env);
      return result;
    } catch (err) {
      audit({ ...auditBase, outcome: 'backend_error', latency_ms: Date.now() - start }, env);
      return {
        content: [{ type: 'text', text: `${route.product} error: ${sanitizeError(err instanceof Error ? err.message : String(err))}` }],
        isError: true,
      };
    }
  }

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
        'X-Service-Binding': env.SERVICE_BINDING_SECRET,
        'X-Gateway-Tenant-Id': session.tenantId ?? '',
        'X-Gateway-User-Id': session.userId ?? '',
        'X-Tenant-User-Id': session.userId ?? '',
        'X-Gateway-Tier': session.tier,
        'X-Gateway-Scopes': session.scopes.join(','),
      },
      body: JSON.stringify(rpcBody),
      signal: AbortSignal.timeout(route.timeout ?? 10_000),
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
      try {
        body = await response.json();
      } catch {
        audit({ ...auditBase, outcome: 'backend_error', latency_ms: Date.now() - start }, env);
        return {
          content: [{ type: 'text', text: `Backend returned malformed JSON (${route.product})` }],
          isError: true,
        };
      }
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
    } catch (err) {
      // Tenant resolution failed — cannot proceed without a tenantId.
      // Backends reject empty tenant IDs, so failing here is better than
      // silently forwarding requests that will 404 downstream.
      console.error(`[gateway] provisionTenant failed for ${oauthProps.userId}: ${err instanceof Error ? err.message : String(err)}`);
      return {
        authenticated: false,
        error: 'tenant_resolution_failed',
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
