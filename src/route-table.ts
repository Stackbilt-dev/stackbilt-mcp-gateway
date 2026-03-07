// ─── Route Table ──────────────────────────────────────────────
// Static mapping of tool name prefixes to backend Service Bindings.
// Adding a new product = one entry here + one Service Binding in wrangler.toml.

import type { RiskLevel, GatewayEnv } from './types.js';

export interface BackendRoute {
  /** Tool name prefix (e.g. "flow", "image") */
  prefix: string;
  /** Human label for discovery/errors */
  product: string;
  /** Key in GatewayEnv for the Service Binding */
  bindingKey: keyof Pick<GatewayEnv, 'STACKBILDER' | 'IMG_FORGE'>;
  /** Path on the backend worker that handles MCP JSON-RPC */
  mcpPath: string;
}

export const ROUTE_TABLE: readonly BackendRoute[] = [
  {
    prefix: 'flow',
    product: 'Stackbilder',
    bindingKey: 'STACKBILDER',
    mcpPath: '/mcp',
  },
  {
    prefix: 'image',
    product: 'img-forge',
    bindingKey: 'IMG_FORGE',
    mcpPath: '/',
  },
] as const;

// ─── Tool risk level registry (Security Constitution) ─────────
// Every tool MUST have an explicit risk level. The gateway rejects
// tools that aren't in this map at discovery time.
export const TOOL_RISK_LEVELS: Record<string, RiskLevel> = {
  // Stackbilder tools
  'flow.create': 'LOCAL_MUTATION',
  'flow.status': 'READ_ONLY',
  'flow.summary': 'READ_ONLY',
  'flow.quality': 'READ_ONLY',
  'flow.governance': 'READ_ONLY',
  'flow.advance': 'LOCAL_MUTATION',
  'flow.recover': 'LOCAL_MUTATION',

  // img-forge tools
  'image.generate': 'EXTERNAL_MUTATION',
  'image.list_models': 'READ_ONLY',
  'image.check_job': 'READ_ONLY',
};

/** Resolve a tool name to its backend route. Returns null if no prefix matches. */
export function resolveRoute(toolName: string): { route: BackendRoute; backendToolName: string } | null {
  const dotIndex = toolName.indexOf('.');
  if (dotIndex === -1) return null;

  const prefix = toolName.slice(0, dotIndex);
  const route = ROUTE_TABLE.find(r => r.prefix === prefix);
  if (!route) return null;

  // Strip the gateway prefix to get the backend's native tool name
  // e.g. "image.generate" → "generate_image" mapping handled per-backend
  const backendToolName = toolName.slice(dotIndex + 1);
  return { route, backendToolName };
}

/** Get risk level for a gateway-namespaced tool name */
export function getToolRiskLevel(toolName: string): RiskLevel | undefined {
  return TOOL_RISK_LEVELS[toolName];
}
