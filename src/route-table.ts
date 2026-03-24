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
  bindingKey: keyof Pick<GatewayEnv, 'STACKBILDER' | 'IMG_FORGE' | 'TAROTSCRIPT' | 'ENGINE' | 'DEPLOYER' | 'VISUAL_QA' | 'TRANSPILER' | 'MCP_CLOUDFLARE_OPS' | 'MCP_DATABASE' | 'MCP_MEMORY' | 'MCP_GIT_OPS'>;
  /** Path on the backend worker that handles MCP JSON-RPC */
  mcpPath: string;
  /** If true, backend uses REST API not MCP JSON-RPC — gateway translates */
  restApi?: boolean;
  /** Backend timeout in ms. Defaults to 10_000. Image gen and scaffold need longer. */
  timeout?: number;
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
    timeout: 60_000,
  },
  {
    prefix: 'scaffold',
    product: 'TarotScript',
    bindingKey: 'TAROTSCRIPT',
    mcpPath: '/run',
    restApi: true,
    timeout: 60_000,
  },
  {
    prefix: 'visual',
    product: 'Visual QA',
    bindingKey: 'VISUAL_QA',
    mcpPath: '/analyze',
    restApi: true,
  },

  // ─── MCP Toolbox servers ────────────────────────────────────
  {
    prefix: 'cfops',
    product: 'Cloudflare Ops',
    bindingKey: 'MCP_CLOUDFLARE_OPS',
    mcpPath: '/mcp',
    timeout: 30_000,
  },
  {
    prefix: 'db',
    product: 'Database',
    bindingKey: 'MCP_DATABASE',
    mcpPath: '/mcp',
    timeout: 30_000,
  },
  {
    prefix: 'mem',
    product: 'Memory',
    bindingKey: 'MCP_MEMORY',
    mcpPath: '/mcp',
  },
  {
    prefix: 'git',
    product: 'Git Ops',
    bindingKey: 'MCP_GIT_OPS',
    mcpPath: '/mcp',
    timeout: 30_000,
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

  // n8n Transpiler tools
  'scaffold_import': 'LOCAL_MUTATION',

  // ─── MCP Toolbox: Cloudflare Ops ────────────────────────────
  'cfops_workers_list': 'READ_ONLY',
  'cfops_workers_deploy': 'EXTERNAL_MUTATION',
  'cfops_workers_delete': 'DESTRUCTIVE',
  'cfops_kv_get': 'READ_ONLY',
  'cfops_kv_put': 'EXTERNAL_MUTATION',
  'cfops_kv_list': 'READ_ONLY',
  'cfops_kv_delete': 'EXTERNAL_MUTATION',
  'cfops_d1_query': 'EXTERNAL_MUTATION',
  'cfops_d1_list': 'READ_ONLY',
  'cfops_r2_put': 'EXTERNAL_MUTATION',
  'cfops_r2_get': 'READ_ONLY',
  'cfops_r2_list': 'READ_ONLY',
  'cfops_r2_delete': 'EXTERNAL_MUTATION',
  'cfops_ops_health': 'READ_ONLY',

  // ─── MCP Toolbox: Database ──────────────────────────────────
  'db_query': 'EXTERNAL_MUTATION',
  'db_list': 'READ_ONLY',
  'db_tables': 'READ_ONLY',
  'db_schema': 'READ_ONLY',
  'db_export': 'READ_ONLY',
  'db_import': 'EXTERNAL_MUTATION',
  'db_backup_create': 'LOCAL_MUTATION',
  'db_backup_restore': 'DESTRUCTIVE',
  'db_cache_stats': 'READ_ONLY',

  // ─── MCP Toolbox: Memory ────────────────────────────────────
  'mem_memory_store': 'LOCAL_MUTATION',
  'mem_memory_retrieve': 'READ_ONLY',
  'mem_memory_search': 'READ_ONLY',
  'mem_memory_list': 'READ_ONLY',
  'mem_memory_delete': 'LOCAL_MUTATION',
  'mem_memory_forget': 'DESTRUCTIVE',

  // ─── MCP Toolbox: Git Ops ──────────────────────────────────
  'git_github_list_repos': 'READ_ONLY',
  'git_github_get_repo': 'READ_ONLY',
  'git_github_create_pr': 'EXTERNAL_MUTATION',
  'git_github_list_prs': 'READ_ONLY',
  'git_github_get_pr': 'READ_ONLY',
  'git_github_list_branches': 'READ_ONLY',
  'git_github_create_branch': 'LOCAL_MUTATION',
  'git_github_get_diff': 'READ_ONLY',
  'git_github_get_file': 'READ_ONLY',
  'git_github_rate_limit': 'READ_ONLY',
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
