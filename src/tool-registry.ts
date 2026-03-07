// ─── Tool Registry ────────────────────────────────────────────
// Aggregates tool definitions from all backend product workers.
// Applies gateway-level namespacing (prefix.name) and validates
// that every tool has a declared risk level (Security Constitution).

import type { RiskLevel } from './types.js';
import { ROUTE_TABLE, TOOL_RISK_LEVELS } from './route-table.js';

export interface GatewayToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    /** Stackbilt Security Constitution: explicit risk level */
    riskLevel: RiskLevel;
  };
}

// ─── Backend tool name → gateway name mapping ─────────────────
// Some backends use different naming conventions. This map translates
// backend-native names to gateway-namespaced names.
const TOOL_NAME_MAP: Record<string, Record<string, string>> = {
  image: {
    generate_image: 'image.generate',
    list_models: 'image.list_models',
    check_job: 'image.check_job',
  },
  flow: {
    'flow.create': 'flow.create',
    'flow.status': 'flow.status',
    'flow.summary': 'flow.summary',
    'flow.quality': 'flow.quality',
    'flow.governance': 'flow.governance',
    'flow.advance': 'flow.advance',
    'flow.recover': 'flow.recover',
  },
};

// Reverse map: gateway name → backend native name
const REVERSE_TOOL_NAME_MAP: Record<string, string> = {};
for (const [_prefix, mapping] of Object.entries(TOOL_NAME_MAP)) {
  for (const [backendName, gatewayName] of Object.entries(mapping)) {
    REVERSE_TOOL_NAME_MAP[gatewayName] = backendName;
  }
}

/** Given a gateway tool name, return the backend's native name */
export function toBackendToolName(gatewayName: string): string {
  return REVERSE_TOOL_NAME_MAP[gatewayName] ?? gatewayName;
}

/** Given a backend tool name and prefix, return the gateway name */
export function toGatewayToolName(backendName: string, prefix: string): string | null {
  const mapping = TOOL_NAME_MAP[prefix];
  if (!mapping) return null;
  return mapping[backendName] ?? null;
}

/** Validate that a tool's inputSchema is a valid JSON Schema object */
export function validateInputSchema(schema: unknown): schema is Record<string, unknown> {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return false;
  const s = schema as Record<string, unknown>;
  // Must have type: "object" at minimum
  return s['type'] === 'object';
}

/** Build the static aggregated tool catalog with risk annotations */
export function buildAggregatedCatalog(): GatewayToolDefinition[] {
  const catalog: GatewayToolDefinition[] = [];

  for (const route of ROUTE_TABLE) {
    const mapping = TOOL_NAME_MAP[route.prefix];
    if (!mapping) continue;

    for (const [_backendName, gatewayName] of Object.entries(mapping)) {
      const riskLevel = TOOL_RISK_LEVELS[gatewayName];
      if (!riskLevel) {
        // Security Constitution: reject tools without explicit risk levels
        console.warn(`[gateway] Tool ${gatewayName} has no declared risk level — skipped`);
        continue;
      }

      catalog.push({
        name: gatewayName,
        description: `[${route.product}] Proxied tool — use tools/list for full description`,
        inputSchema: { type: 'object', properties: {} },
        annotations: {
          readOnlyHint: riskLevel === 'READ_ONLY',
          destructiveHint: riskLevel === 'DESTRUCTIVE',
          riskLevel,
        },
      });
    }
  }

  return catalog;
}

/** Validate tool call arguments against basic schema constraints */
export function validateToolArguments(
  args: unknown,
  schema: Record<string, unknown>,
): { valid: true } | { valid: false; message: string } {
  if (args === undefined || args === null) {
    const required = schema['required'] as string[] | undefined;
    if (required && required.length > 0) {
      return { valid: false, message: `Missing required arguments: ${required.join(', ')}` };
    }
    return { valid: true };
  }
  if (typeof args !== 'object' || Array.isArray(args)) {
    return { valid: false, message: 'Arguments must be an object' };
  }
  return { valid: true };
}
