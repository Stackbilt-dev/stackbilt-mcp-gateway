// ─── Audit Chain (Security Constitution) ──────────────────────
// Every tool invocation emits a structured audit artifact.
// Secrets are redacted BEFORE emission — nothing sensitive hits logs.

import type { RiskLevel } from './types.js';

export interface AuditArtifact {
  trace_id: string;
  principal: string;
  tenant: string;
  tool: string;
  risk_level: RiskLevel | 'UNKNOWN';
  policy_decision: 'ALLOW' | 'DENY';
  redacted_input_summary: string;
  outcome: 'success' | 'error' | 'backend_error' | 'auth_denied' | 'unknown_tool' | 'invalid_params';
  timestamp: string;
  latency_ms?: number;
}

// Patterns that MUST be scrubbed before any log emission
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/sb_(live|test)_[a-zA-Z0-9]+/g, '[REDACTED_KEY]'],
  [/Bearer\s+[^\s"]+/gi, 'Bearer [REDACTED]'],
  [/[a-f0-9]{32,}/gi, '[REDACTED_HASH]'],
  [/password"?\s*[:=]\s*"?[^",}\s]+"?/gi, 'password:[REDACTED]'],
  [/secret"?\s*[:=]\s*"?[^",}\s]+"?/gi, 'secret:[REDACTED]'],
  [/api[_-]?key"?\s*[:=]\s*"?[^",}\s]+"?/gi, 'api_key:[REDACTED]'],
];

export function redact(input: string): string {
  let result = input;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

export function summarizeInput(args: unknown, maxLength = 200): string {
  if (args === undefined || args === null) return '{}';
  let raw: string;
  try {
    raw = JSON.stringify(args);
  } catch {
    raw = String(args);
  }
  const redacted = redact(raw);
  return redacted.length > maxLength ? redacted.slice(0, maxLength) + '...' : redacted;
}

export function generateTraceId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export function emitAudit(artifact: AuditArtifact): void {
  // Redact mutable string fields before serialization (not trace_id/timestamp/tool which are structural)
  const safe: AuditArtifact = {
    ...artifact,
    principal: redact(artifact.principal),
    tenant: redact(artifact.tenant),
    redacted_input_summary: redact(artifact.redacted_input_summary),
  };
  console.log(`[audit] ${JSON.stringify(safe)}`);
}

/** Fire-and-forget: push a redacted audit artifact to the BizOps queue as a tool.called event. */
export function queueAuditEvent(queue: Queue, artifact: AuditArtifact): void {
  const safe: AuditArtifact = {
    ...artifact,
    principal: redact(artifact.principal),
    tenant: redact(artifact.tenant),
    redacted_input_summary: redact(artifact.redacted_input_summary),
  };
  queue.send({
    event_type: 'tool.called',
    event_id: safe.trace_id,
    trace_id: safe.trace_id,
    principal: safe.principal,
    tenant: safe.tenant,
    tool: safe.tool,
    risk_level: safe.risk_level,
    policy_decision: safe.policy_decision,
    redacted_input_summary: safe.redacted_input_summary,
    outcome: safe.outcome,
    latency_ms: safe.latency_ms,
    timestamp: safe.timestamp,
  }).catch((err) => {
    console.error('[audit] Queue emit failed:', err);
  });
}
