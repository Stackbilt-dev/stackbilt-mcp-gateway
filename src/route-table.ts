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
  bindingKey: keyof Pick<GatewayEnv, 'STACKBILDER' | 'IMG_FORGE' | 'TAROTSCRIPT' | 'ENGINE' | 'DEPLOYER' | 'VISUAL_QA'>;
  /** Path on the backend worker that handles MCP JSON-RPC */
  mcpPath: string;
  /** If true, backend uses REST API not MCP JSON-RPC — gateway translates */
  restApi?: boolean;
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
    mcpPath: '/mcp',
  },
  {
    prefix: 'scaffold',
    product: 'TarotScript',
    bindingKey: 'TAROTSCRIPT',
    mcpPath: '/run',
    restApi: true,
  },
  {
    prefix: 'visual',
    product: 'Visual QA',
    bindingKey: 'VISUAL_QA',
    mcpPath: '/analyze',
    restApi: true,
  },
] as const;

// ─── Tool risk level registry (Security Constitution) ─────────
// Every tool MUST have an explicit risk level. The gateway rejects
// tools that aren't in this map at discovery time.
export const TOOL_RISK_LEVELS: Record<string, RiskLevel> = {
  // Stackbilder tools
  'flow_create': 'LOCAL_MUTATION',
  'flow_status': 'READ_ONLY',
  'flow_summary': 'READ_ONLY',
  'flow_quality': 'READ_ONLY',
  'flow_governance': 'READ_ONLY',
  'flow_advance': 'LOCAL_MUTATION',
  'flow_recover': 'LOCAL_MUTATION',

  // img-forge tools
  'image_generate': 'EXTERNAL_MUTATION',
  'image_list_models': 'READ_ONLY',
  'image_check_job': 'READ_ONLY',

  // TarotScript scaffold tools
  'scaffold_create': 'LOCAL_MUTATION',
  'scaffold_classify': 'READ_ONLY',
  'scaffold_status': 'READ_ONLY',
  'scaffold_publish': 'EXTERNAL_MUTATION',
  'scaffold_deploy': 'EXTERNAL_MUTATION',

  // Visual QA tools
  'visual_screenshot': 'LOCAL_MUTATION',
  'visual_analyze': 'LOCAL_MUTATION',
  'visual_pages': 'READ_ONLY',
};

/** Resolve a tool name to its backend route. Returns null if no prefix matches. */
export function resolveRoute(toolName: string): { route: BackendRoute; backendToolName: string } | null {
  // Match against known prefixes (e.g. "flow_create" → prefix "flow", remainder "create")
  for (const route of ROUTE_TABLE) {
    const prefixWithSep = route.prefix + '_';
    if (toolName.startsWith(prefixWithSep)) {
      const backendToolName = toolName.slice(prefixWithSep.length);
      return { route, backendToolName };
    }
  }
  return null;
}

/** Get risk level for a gateway-namespaced tool name */
export function getToolRiskLevel(toolName: string): RiskLevel | undefined {
  return TOOL_RISK_LEVELS[toolName];
}
