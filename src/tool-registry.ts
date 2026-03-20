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
    generate_image: 'image_generate',
    list_models: 'image_list_models',
    check_job: 'image_check_job',
  },
  flow: {
    'flow_create': 'flow_create',
    'flow_status': 'flow_status',
    'flow_summary': 'flow_summary',
    'flow_quality': 'flow_quality',
    'flow_governance': 'flow_governance',
    'flow_advance': 'flow_advance',
    'flow_recover': 'flow_recover',
  },
  scaffold: {
    'scaffold_create': 'scaffold_create',
    'scaffold_classify': 'scaffold_classify',
    'scaffold_status': 'scaffold_status',
    'scaffold_publish': 'scaffold_publish',
    'scaffold_deploy': 'scaffold_deploy',
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
  // ── Stackbilder (flow_*) ──────────────────────────────────
  {
    gatewayName: 'flow_create',
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
    gatewayName: 'flow_status',
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
    gatewayName: 'flow_summary',
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
    gatewayName: 'flow_quality',
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
    gatewayName: 'flow_governance',
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
    gatewayName: 'flow_advance',
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
    gatewayName: 'flow_recover',
    description: 'Recover a failed flow, resuming from the failed mode.',
    inputSchema: {
      type: 'object',
      properties: {
        flowId: { type: 'string', description: 'Flow identifier' },
      },
      required: ['flowId'],
    },
  },

  // ── img-forge (image_*) ───────────────────────────────────
  {
    gatewayName: 'image_generate',
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
    gatewayName: 'image_list_models',
    description: 'List all available image generation models and their quality tiers.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    gatewayName: 'image_check_job',
    description: 'Check the status of an image generation job by its ID. Use this to poll async jobs or verify completed generations.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'The UUID of the generation job to check.' },
      },
      required: ['job_id'],
    },
  },

  // ── TarotScript scaffold tools (scaffold_*) ─────────────────
  {
    gatewayName: 'scaffold_create',
    description:
      'Generate a complete project scaffold using the TarotScript deterministic engine. ' +
      'Runs spec-cast spreads across 6 modes (PRODUCT, UX, RISK, ARCHITECT, TDD, SPRINT) ' +
      'with optional oracle prose polish. Returns structured facts, materialized project files ' +
      '(.ai/ governance, package.json, wrangler.toml, src/, test/), and next steps. ' +
      'Zero inference for structure, single optional LLM call for prose. ~20ms for structure, ' +
      '~2s with oracle. 21x faster and 95% cheaper than flow_create.',
    inputSchema: {
      type: 'object',
      properties: {
        intention: {
          type: 'string',
          minLength: 1,
          maxLength: 2000,
          description: 'Project description — what you want to build. Be specific about domain, users, and key features.',
        },
        project_type: {
          type: 'string',
          enum: ['saas', 'api', 'marketplace', 'dashboard', 'mobile', 'cli', 'library'],
          description: 'Type of project. Influences which deck cards are most relevant.',
        },
        complexity: {
          type: 'string',
          enum: ['simple', 'moderate', 'complex'],
          default: 'moderate',
          description: 'Project complexity. Affects number of cards drawn per mode.',
        },
        oracle: {
          type: 'boolean',
          default: false,
          description: 'Enable oracle prose polish. Adds a single LLM call (~2s) to generate natural language output from structured facts.',
        },
        modes: {
          type: 'array',
          items: { type: 'string', enum: ['product', 'ux', 'risk', 'architect', 'tdd', 'sprint'] },
          description: 'Specific modes to run. Omit for all 6.',
        },
      },
      required: ['intention'],
    },
  },
  {
    gatewayName: 'scaffold_classify',
    description:
      'Classify a user message into one of 14 intent categories using the TarotScript ' +
      'classify-cast spread. Zero inference — uses semantic keyword matching against the ' +
      'aegis-intents deck. Returns primary classification, confidence, secondary intent, ' +
      'and compound intent detection.',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          minLength: 1,
          maxLength: 2000,
          description: 'The user message to classify.',
        },
        source: {
          type: 'string',
          enum: ['user', 'internal', 'voice'],
          default: 'user',
          description: 'Message source channel.',
        },
      },
      required: ['message'],
    },
  },
  {
    gatewayName: 'scaffold_publish',
    description:
      'Publish scaffold_create output to a GitHub repository. Takes the files[] array from scaffold_create ' +
      'and creates a new repo with an atomic initial commit via the Git Data API. ' +
      'Returns repo URL, clone URL, and next steps for deployment. ' +
      'Requires a GitHub token (pass as parameter or set GITHUB_TOKEN secret on the gateway).',
    inputSchema: {
      type: 'object',
      properties: {
        repo_name: {
          type: 'string',
          minLength: 1,
          maxLength: 100,
          description: 'Repository name (e.g., "my-restaurant-api"). Will be created under the specified owner.',
        },
        owner: {
          type: 'string',
          description: 'GitHub org or username to create the repo under. Defaults to gateway config.',
        },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File path (e.g., "src/index.ts")' },
              content: { type: 'string', description: 'File content' },
            },
            required: ['path', 'content'],
          },
          description: 'Files to commit. Pass the files[] array from scaffold_create output.',
        },
        github_token: {
          type: 'string',
          description: 'GitHub Personal Access Token with repo scope. Optional if GITHUB_TOKEN is set on the gateway.',
        },
        private: {
          type: 'boolean',
          default: true,
          description: 'Whether to create a private repo. Defaults to true.',
        },
        description: {
          type: 'string',
          description: 'Repository description.',
        },
        commit_message: {
          type: 'string',
          description: 'Custom initial commit message.',
        },
      },
      required: ['repo_name', 'files'],
    },
  },
  {
    gatewayName: 'scaffold_deploy',
    description:
      'Deploy a Cloudflare Worker to a user\'s account. Takes a bundled script, worker name, and CF credentials. ' +
      'Quality gate rejects unimplemented scaffold stubs. Post-deploy health check verifies the Worker is live. ' +
      'Audit-logged. Rate limited to 5 deploys/hour.',
    inputSchema: {
      type: 'object',
      properties: {
        cf_api_token: {
          type: 'string',
          description: 'Cloudflare API token with Workers Scripts:Edit scope.',
        },
        cf_account_id: {
          type: 'string',
          description: 'Cloudflare account ID to deploy to.',
        },
        worker_name: {
          type: 'string',
          minLength: 1,
          maxLength: 63,
          description: 'Name for the Worker (becomes the subdomain).',
        },
        script: {
          type: 'string',
          description: 'Bundled JavaScript/TypeScript Worker script content.',
        },
        compatibility_date: {
          type: 'string',
          description: 'Workers compatibility date (default: 2026-03-20).',
        },
        compatibility_flags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Compatibility flags (default: ["nodejs_compat"]).',
        },
        bindings: {
          type: 'array',
          items: { type: 'object' },
          description: 'Worker bindings (D1, KV, etc.) in Cloudflare API format.',
        },
      },
      required: ['cf_api_token', 'cf_account_id', 'worker_name', 'script'],
    },
  },
  {
    gatewayName: 'scaffold_status',
    description: 'Get TarotScript engine health status, available spreads, and deck statistics.',
    inputSchema: {
      type: 'object',
      properties: {},
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
