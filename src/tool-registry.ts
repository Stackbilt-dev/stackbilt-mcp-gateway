// ─── Tool Registry ────────────────────────────────────────────
// Aggregates tool definitions from all backend product workers.
// Applies gateway-level namespacing (prefix.name) and validates
// that every tool has a declared risk level (Security Constitution).
//
// Schemas are sourced from backend tool-registry/tool definitions
// and hardcoded here. The gateway owns the contract surface —
// backends require auth+session for tools/list which makes dynamic
// fetching over Service Bindings impractical.

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
  return s['type'] === 'object';
}

// ─── Real tool schemas (sourced from backend registries) ──────

interface ToolSpec {
  gatewayName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOL_SPECS: ToolSpec[] = [
  // ── Stackbilder (flow.*) ──────────────────────────────────
  {
    gatewayName: 'flow.create',
    description: 'Create a new orchestration flow with an execution policy.',
    inputSchema: {
      type: 'object',
      properties: {
        policy: { type: 'object', description: 'Execution policy for the flow' },
        projectId: { type: 'string', description: 'Optional project identifier' },
        projectDescription: { type: 'string', description: 'Free-text project description (max 2000 chars)' },
        taskKeywords: { type: 'array', items: { type: 'string' }, description: 'Optional keywords for run fingerprinting' },
      },
      required: ['policy'],
    },
  },
  {
    gatewayName: 'flow.status',
    description: 'Get current flow status with progress and estimated remaining time.',
    inputSchema: {
      type: 'object',
      properties: {
        flowId: { type: 'string', description: 'Flow identifier' },
      },
      required: ['flowId'],
    },
  },
  {
    gatewayName: 'flow.summary',
    description: 'Get full flow summary including modes, tokens, quality, and artifacts.',
    inputSchema: {
      type: 'object',
      properties: {
        flowId: { type: 'string', description: 'Flow identifier' },
      },
      required: ['flowId'],
    },
  },
  {
    gatewayName: 'flow.quality',
    description: 'Get per-mode quality scores with local and fused assessments.',
    inputSchema: {
      type: 'object',
      properties: {
        flowId: { type: 'string', description: 'Flow identifier' },
      },
      required: ['flowId'],
    },
  },
  {
    gatewayName: 'flow.governance',
    description: 'Get governance posture including effective mode, capping, and determinism profile.',
    inputSchema: {
      type: 'object',
      properties: {
        flowId: { type: 'string', description: 'Flow identifier' },
      },
      required: ['flowId'],
    },
  },
  {
    gatewayName: 'flow.advance',
    description: 'Advance a flow to its next operating mode.',
    inputSchema: {
      type: 'object',
      properties: {
        flowId: { type: 'string', description: 'Flow identifier' },
      },
      required: ['flowId'],
    },
  },
  {
    gatewayName: 'flow.recover',
    description: 'Recover a failed flow, resuming from the failed mode.',
    inputSchema: {
      type: 'object',
      properties: {
        flowId: { type: 'string', description: 'Flow identifier' },
      },
      required: ['flowId'],
    },
  },

  // ── img-forge (image.*) ───────────────────────────────────
  {
    gatewayName: 'image.generate',
    description:
      'Generate an image from a text prompt. Returns a URL to the generated image ' +
      'and metadata about how the prompt was enhanced. Supports 5 quality tiers: ' +
      'draft (fastest, SDXL), standard (FLUX Klein, default), premium (FLUX Dev), ' +
      'ultra (Gemini 2.5 Flash), ultra_plus (Gemini 3.1 Flash). ' +
      'Generation takes 5-30 seconds depending on tier.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          minLength: 1,
          maxLength: 2000,
          description:
            'Text prompt describing the image to generate. Be descriptive — ' +
            'include subject, style, lighting, composition for best results.',
        },
        quality_tier: {
          type: 'string',
          enum: ['draft', 'standard', 'premium', 'ultra', 'ultra_plus'],
          default: 'standard',
          description:
            'Quality tier. draft=fast/low, standard=balanced (default), ' +
            'premium=high detail, ultra/ultra_plus=Gemini models.',
        },
        negative_prompt: {
          type: 'string',
          description: 'Things to avoid in the image (only effective for draft tier with SDXL).',
        },
      },
      required: ['prompt'],
    },
  },
  {
    gatewayName: 'image.list_models',
    description: 'List all available image generation models and their quality tiers.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    gatewayName: 'image.check_job',
    description: 'Check the status of an image generation job by its ID. Use this to poll async jobs or verify completed generations.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'The UUID of the generation job to check.' },
      },
      required: ['job_id'],
    },
  },
];

// ─── Catalog builders ─────────────────────────────────────────

function buildCatalogFromSpecs(): GatewayToolDefinition[] {
  const catalog: GatewayToolDefinition[] = [];

  for (const spec of TOOL_SPECS) {
    const riskLevel = TOOL_RISK_LEVELS[spec.gatewayName];
    if (!riskLevel) {
      console.warn(`[gateway] Tool ${spec.gatewayName} has no declared risk level — skipped`);
      continue;
    }

    catalog.push({
      name: spec.gatewayName,
      description: spec.description,
      inputSchema: spec.inputSchema,
      annotations: {
        readOnlyHint: riskLevel === 'READ_ONLY',
        destructiveHint: riskLevel === 'DESTRUCTIVE',
        riskLevel,
      },
    });
  }

  return catalog;
}

// Cached catalog (built once, immutable)
let cachedCatalog: GatewayToolDefinition[] | null = null;

/** Build the aggregated tool catalog with real schemas and risk annotations */
export function buildAggregatedCatalog(): GatewayToolDefinition[] {
  if (!cachedCatalog) {
    cachedCatalog = buildCatalogFromSpecs();
  }
  return cachedCatalog;
}

// Alias for tests
export const buildStaticCatalog = buildAggregatedCatalog;

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
