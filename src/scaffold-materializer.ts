// ─── Scaffold Materializer ─────────────────────────────────────
// Transforms TarotScript scaffold-cast facts into downloadable
// project files. Zero LLM calls — deterministic from facts.
//
// Input:  facts Record from scaffold-cast (~40 key-value pairs)
// Output: files[] array + nextSteps[]
//
// Card-to-file mapping:
//   requirement → .ai/core.adf (product requirements section)
//   interface   → .ai/core.adf (UX section), src/index.ts (route stubs)
//   threat      → .ai/core.adf (security section)
//   runtime     → wrangler.toml, package.json
//   test_plan   → test/index.test.ts
//   first_task  → .ai/state.adf (sprint backlog)
//   aggregates  → .ai/manifest.adf, README.md

export interface ScaffoldFile {
  path: string;
  content: string;
}

export interface MaterializerResult {
  files: ScaffoldFile[];
  nextSteps: string[];
}

type Facts = Record<string, unknown>;

// ─── Helpers ──────────────────────────────────────────────────

function str(facts: Facts, key: string, fallback = ''): string {
  const v = facts[key];
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.join(', ');
  return fallback;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function traitsInclude(facts: Facts, ...terms: string[]): boolean {
  const v = facts.runtime_traits;
  const joined = Array.isArray(v) ? v.join(' ') : typeof v === 'string' ? v : '';
  return terms.some(t => joined.includes(t));
}

function deriveProjectName(_facts: Facts, intention: string): string {
  const stripped = intention.replace(/^(a|an|the|build|create|make)\s+/i, '');
  return slugify(stripped.split(/\s+/).slice(0, 3).join(' '));
}

// ─── Intent Detection ────────────────────────────────────────
// Augments scaffold output based on keywords in the user's description.

interface DomainHint {
  id: string;
  match: (intention: string) => boolean;
  deps?: Record<string, string>;
  devDeps?: Record<string, string>;
  bindings?: string[];
  scripts?: Record<string, string>;
  envInterface?: string[];
  indexImports?: string[];
  indexBody?: string;
  extraFiles?: ScaffoldFile[];
}

const DOMAIN_HINTS: DomainHint[] = [
  {
    id: 'mcp-server',
    match: (i) => /\bmcp\b/i.test(i) && /\bserver\b/i.test(i),
    deps: { '@modelcontextprotocol/sdk': '^1.0.0' },
    envInterface: ['// MCP server bindings'],
    indexBody: `
    // MCP SSE endpoint
    if (url.pathname === '/sse' || url.pathname === '/mcp') {
      // TODO: wire MCP server handler
      // See: https://modelcontextprotocol.io/docs/server
      return new Response('MCP SSE endpoint — wire server handler', {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
      });
    }

    // MCP tool listing
    if (url.pathname === '/tools') {
      return Response.json({
        tools: [
          // TODO: define your MCP tools
          { name: 'example_tool', description: 'An example tool', inputSchema: { type: 'object', properties: {} } },
        ],
      });
    }`,
  },
  {
    id: 'chatroom',
    match: (i) => /\bchat\s*room\b/i.test(i) || (/\bchat\b/i.test(i) && /\broom\b/i.test(i)) || /\brealtime\b/i.test(i),
    deps: {},
    bindings: [
      `\n[[durable_objects.bindings]]\nname = "CHATROOM"\nclass_name = "ChatRoom"`,
      `\n[[migrations]]\ntag = "v1"\nnew_classes = ["ChatRoom"]`,
    ],
    envInterface: ['CHATROOM: DurableObjectNamespace;'],
    indexBody: `
    // WebSocket upgrade for chat
    if (url.pathname.startsWith('/room/')) {
      const roomId = url.pathname.split('/')[2] ?? 'default';
      const id = env.CHATROOM.idFromName(roomId);
      const stub = env.CHATROOM.get(id);
      return stub.fetch(request);
    }`,
    extraFiles: [{
      path: 'src/chatroom.ts',
      content: `// Durable Object: ChatRoom
// Each room is a persistent, named instance with WebSocket sessions.

export class ChatRoom implements DurableObject {
  private sessions: Set<WebSocket> = new Set();

  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith('/websocket')) {
      const [client, server] = Object.values(new WebSocketPair());
      this.state.acceptWebSocket(server);
      this.sessions.add(server);

      server.addEventListener('message', (event) => {
        // Broadcast to all connected clients
        for (const ws of this.sessions) {
          if (ws !== server && ws.readyState === WebSocket.READY_STATE_OPEN) {
            ws.send(typeof event.data === 'string' ? event.data : '');
          }
        }
      });

      server.addEventListener('close', () => {
        this.sessions.delete(server);
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    // Room info
    return Response.json({
      room: url.pathname.split('/').pop(),
      connections: this.sessions.size,
    });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    for (const session of this.sessions) {
      if (session !== ws && session.readyState === WebSocket.READY_STATE_OPEN) {
        session.send(typeof message === 'string' ? message : '');
      }
    }
  }

  webSocketClose(ws: WebSocket): void {
    this.sessions.delete(ws);
  }
}

interface Env {}
`,
    }],
  },
  {
    id: 'api',
    match: (i) => /\bapi\b/i.test(i) || /\brest\b/i.test(i) || /\bendpoint/i.test(i),
    deps: { 'hono': '^4.0.0' },
    indexImports: ["import { Hono } from 'hono';"],
    indexBody: `
    // API routes (Hono)
    // const app = new Hono<{ Bindings: Env }>();
    // app.get('/api/v1/items', (c) => c.json({ items: [] }));
    // return app.fetch(request, env, ctx);`,
  },
  {
    id: 'cron',
    match: (i) => /\bcron\b/i.test(i) || /\bschedul/i.test(i) || /\bperiodic/i.test(i),
    scripts: {},
    indexBody: `
    // Scheduled handler (cron trigger)
    // Configure in wrangler.toml: [triggers] crons = ["*/5 * * * *"]`,
  },
  {
    id: 'auth',
    match: (i) => /\bauth\b/i.test(i) || /\blogin\b/i.test(i) || /\bjwt\b/i.test(i),
    indexBody: `
    // Auth middleware
    if (url.pathname.startsWith('/api/') && url.pathname !== '/api/health') {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      // TODO: validate JWT or API key
    }`,
  },
];

function detectDomainHints(intention: string): DomainHint[] {
  return DOMAIN_HINTS.filter(h => h.match(intention));
}

// ─── Template Renderers ───────────────────────────────────────

function renderManifestAdf(facts: Facts, projectName: string): string {
  const confidence = str(facts, 'scaffold_confidence', 'moderate');
  const rawBalance = facts.elemental_balance;
  const balance = typeof rawBalance === 'object' && rawBalance !== null
    ? Object.entries(rawBalance as Record<string, number>).filter(([, v]) => v > 0).map(([k, v]) => `${k}:${v}`).join(' ') || 'neutral'
    : str(facts, 'elemental_balance', 'unknown');
  const shadowDensity = facts.shadow_density ?? 'unknown';

  return `# ${projectName} — ADF Manifest
# Generated by scaffold-cast (TarotScript deterministic engine)
# Confidence: ${confidence} | Shadow density: ${shadowDensity}

version: "0.1"
project: "${projectName}"

## Modules

- core.adf        # Product requirements, UX, security
- state.adf       # Sprint backlog and current task

## On-Demand Triggers

| Domain     | Trigger Keywords                     |
|------------|--------------------------------------|
| product    | ${str(facts, 'requirement_name')}, requirements, features |
| ux         | ${str(facts, 'interface_name')}, layout, components |
| security   | ${str(facts, 'threat_name')}, threat, mitigation |
| runtime    | ${str(facts, 'runtime_name')}, deploy, worker |
| testing    | ${str(facts, 'test_plan_name')}, test, coverage |
| sprint     | ${str(facts, 'first_task_name')}, task, estimate |

## Metrics

| Metric              | Value         |
|---------------------|---------------|
| position_count      | ${facts.position_count ?? 6} |
| shadow_density      | ${shadowDensity} |
| elemental_balance   | ${balance}    |
| scaffold_confidence | ${confidence} |
`;
}

function renderCoreAdf(facts: Facts, projectName: string): string {
  const reqName = str(facts, 'requirement_name');
  const reqPriority = str(facts, 'requirement_priority', 'P1');
  const reqEffort = str(facts, 'requirement_effort', 'medium');
  const reqAcceptance = str(facts, 'requirement_acceptance');

  const ifaceName = str(facts, 'interface_name');
  const ifaceRegions = str(facts, 'interface_regions');
  const ifaceGrid = str(facts, 'interface_grid');
  const ifaceComponents = str(facts, 'interface_components');

  const threatName = str(facts, 'threat_name');
  const threatLikelihood = str(facts, 'threat_likelihood');
  const threatImpact = str(facts, 'threat_impact');
  const threatMitigation = str(facts, 'threat_mitigation');

  return `# ${projectName} — Core
# Product requirements, UX patterns, and security constraints

## Product Requirements

### ${reqName}
- **Priority**: ${reqPriority}
- **Effort**: ${reqEffort}
- **Acceptance criteria**: ${reqAcceptance}

## UX Pattern

### ${ifaceName}
- **Regions**: ${ifaceRegions}
- **Grid**: ${ifaceGrid}
- **Components**: ${ifaceComponents}

## Security

### ${threatName}
- **Likelihood**: ${threatLikelihood}
- **Impact**: ${threatImpact}
- **Mitigation**: ${threatMitigation}
`;
}

function renderStateAdf(facts: Facts, projectName: string): string {
  const taskName = str(facts, 'first_task_name');
  const taskEstimate = str(facts, 'first_task_estimate');
  const taskComplexity = str(facts, 'first_task_complexity');
  const taskDeliverable = str(facts, 'first_task_deliverable');

  return `# ${projectName} — State
# Current sprint backlog

## Current Sprint

### ${taskName}
- **Estimate**: ${taskEstimate} points
- **Complexity**: ${taskComplexity}
- **Deliverable**: ${taskDeliverable}
- **Status**: not_started

## Velocity

| Sprint | Points Planned | Points Done |
|--------|---------------|-------------|
| 1      | ${taskEstimate}            | —           |
`;
}

function renderPackageJson(facts: Facts, projectName: string, hints: DomainHint[] = []): string {
  const runtimeName = str(facts, 'runtime_name');
  const testFramework = str(facts, 'test_plan_framework', 'vitest');

  // Infer if this is a Workers project from runtime card traits/name
  const isWorkers = traitsInclude(facts, 'edge', 'v8-isolate', 'serverless', 'isolat') ||
    runtimeName.toLowerCase().includes('worker');

  const deps: Record<string, string> = {};
  const devDeps: Record<string, string> = {
    typescript: '^5.5.0',
  };

  if (isWorkers) {
    devDeps['wrangler'] = '^3.0.0';
    devDeps['@cloudflare/workers-types'] = '^4.0.0';
  }

  // Test framework
  if (testFramework.includes('vitest') || testFramework === 'vitest') {
    devDeps['vitest'] = '^2.0.0';
  } else if (testFramework.includes('jest')) {
    devDeps['jest'] = '^29.0.0';
    devDeps['ts-jest'] = '^29.0.0';
  }

  const scripts: Record<string, string> = {
    build: 'tsc',
    typecheck: 'tsc --noEmit',
  };

  if (isWorkers) {
    scripts.dev = 'wrangler dev';
    scripts.deploy = 'wrangler deploy';
  }

  if (testFramework.includes('vitest')) {
    scripts.test = 'vitest run';
  } else {
    scripts.test = 'jest';
  }

  // Merge domain-specific dependencies
  for (const hint of hints) {
    if (hint.deps) Object.assign(deps, hint.deps);
    if (hint.devDeps) Object.assign(devDeps, hint.devDeps);
    if (hint.scripts) Object.assign(scripts, hint.scripts);
  }

  return JSON.stringify({
    name: projectName,
    version: '0.1.0',
    private: true,
    scripts,
    dependencies: Object.keys(deps).length > 0 ? deps : undefined,
    devDependencies: devDeps,
  }, null, 2);
}

function renderWranglerToml(facts: Facts, projectName: string, hints: DomainHint[] = []): string {
  // Infer bindings from runtime card traits
  const bindings: string[] = [];

  if (traitsInclude(facts, 'd1', 'sql', 'database')) {
    bindings.push(`
[[d1_databases]]
binding = "DB"
database_name = "${projectName}"
database_id = "" # TODO: create with wrangler d1 create ${projectName}`);
  }

  if (traitsInclude(facts, 'kv', 'key-value', 'cache')) {
    bindings.push(`
[[kv_namespaces]]
binding = "KV"
id = "" # TODO: create with wrangler kv namespace create ${projectName}`);
  }

  if (traitsInclude(facts, 'queue', 'async', 'background')) {
    bindings.push(`
[[queues.producers]]
queue = "${projectName}-tasks"
binding = "QUEUE"`);
  }

  // Add domain-specific bindings
  for (const hint of hints) {
    if (hint.bindings) bindings.push(...hint.bindings);
  }

  return `name = "${projectName}"
main = "src/index.ts"
compatibility_date = "${new Date().toISOString().split('T')[0]}"
compatibility_flags = ["nodejs_compat"]
${bindings.join('\n')}
`;
}

function renderIndexTs(facts: Facts, hints: DomainHint[] = []): string {
  const ifaceName = str(facts, 'interface_name');
  const reqName = str(facts, 'requirement_name');
  const threatMitigation = str(facts, 'threat_mitigation');

  // Collect domain-specific imports and route bodies
  const imports: string[] = [];
  const routeBodies: string[] = [];
  const envFields: string[] = [];

  for (const hint of hints) {
    if (hint.indexImports) imports.push(...hint.indexImports);
    if (hint.indexBody) routeBodies.push(hint.indexBody);
    if (hint.envInterface) envFields.push(...hint.envInterface);
  }

  const importsBlock = imports.length > 0 ? imports.join('\n') + '\n\n' : '';
  const routesBlock = routeBodies.length > 0 ? routeBodies.join('\n') + '\n' : '';
  const envBlock = envFields.length > 0 ? '\n  ' + envFields.join('\n  ') : '\n  // TODO: add bindings from wrangler.toml';

  // Check if chatroom hint is present — export the DO class
  const hasChatroom = hints.some(h => h.id === 'chatroom');
  const reExports = hasChatroom ? "\nexport { ChatRoom } from './chatroom';\n" : '';

  return `${importsBlock}// ${reqName} — main entry point
// UX pattern: ${ifaceName}
// Security: ${threatMitigation || 'standard hardening'}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', timestamp: new Date().toISOString() });
    }
${routesBlock}
    // TODO: implement ${reqName} handler
    return Response.json({ error: 'not implemented' }, { status: 501 });
  },
} satisfies ExportedHandler<Env>;

interface Env {${envBlock}
}
${reExports}`;
}

function renderTestFile(facts: Facts, projectName: string): string {
  const testFramework = str(facts, 'test_plan_framework', 'vitest');
  const coverageTarget = str(facts, 'test_plan_coverage_target', '80%');
  const ciStage = str(facts, 'test_plan_ci_stage', 'pre-merge');
  const reqName = str(facts, 'requirement_name');

  if (testFramework.includes('vitest') || testFramework === 'vitest') {
    return `import { describe, it, expect } from 'vitest';

// Test plan: ${str(facts, 'test_plan_name')}
// CI stage: ${ciStage}
// Coverage target: ${coverageTarget}

describe('${reqName}', () => {
  it('should respond to health check', async () => {
    // TODO: import worker and test with miniflare or unstable_dev
    expect(true).toBe(true);
  });

  it('should handle primary use case', async () => {
    // TODO: implement ${reqName} test
    expect(true).toBe(true);
  });
});
`;
  }

  return `// Test plan: ${str(facts, 'test_plan_name')}
// CI stage: ${ciStage}
// Coverage target: ${coverageTarget}

describe('${reqName}', () => {
  it('should respond to health check', async () => {
    expect(true).toBe(true);
  });
});
`;
}

function renderReadme(facts: Facts, projectName: string, intention: string): string {
  const reqName = str(facts, 'requirement_name');
  const reqPriority = str(facts, 'requirement_priority', 'P1');
  const ifaceName = str(facts, 'interface_name');
  const threatName = str(facts, 'threat_name');
  const runtimeName = str(facts, 'runtime_name');
  const testName = str(facts, 'test_plan_name');
  const taskName = str(facts, 'first_task_name');
  const confidence = str(facts, 'scaffold_confidence', 'moderate');

  return `# ${projectName}

> ${intention}

Scaffolded by [Stackbilt](https://stackbilt.dev). Confidence: **${confidence}**.

## Architecture

| Mode | Card | Key Detail |
|------|------|------------|
| Product | ${reqName} | Priority: ${reqPriority} |
| UX | ${ifaceName} | ${str(facts, 'interface_regions')} |
| Risk | ${threatName} | ${str(facts, 'threat_likelihood')} likelihood, ${str(facts, 'threat_impact')} impact |
| Runtime | ${runtimeName} | ${str(facts, 'runtime_traits')} |
| Test | ${testName} | ${str(facts, 'test_plan_framework')} @ ${str(facts, 'test_plan_ci_stage')} |
| Sprint | ${taskName} | ${str(facts, 'first_task_estimate')} pts, ${str(facts, 'first_task_complexity')} |

## Getting Started

\`\`\`bash
npm install
npx wrangler dev
\`\`\`

## First Task

**${taskName}** — ${str(facts, 'first_task_deliverable')}
- Estimate: ${str(facts, 'first_task_estimate')} points
- Complexity: ${str(facts, 'first_task_complexity')}
`;
}

function renderTsConfig(): string {
  return JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ES2022',
      moduleResolution: 'bundler',
      lib: ['ES2022'],
      types: ['@cloudflare/workers-types'],
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
    },
    include: ['src'],
  }, null, 2);
}

// ─── Main Materializer ───────────────────────────────────────

export function materializeScaffold(
  facts: Facts,
  intention: string,
): MaterializerResult {
  const projectName = deriveProjectName(facts, intention);
  const hints = detectDomainHints(intention);

  const files: ScaffoldFile[] = [
    // Governance first (.ai/ before src/)
    { path: '.ai/manifest.adf', content: renderManifestAdf(facts, projectName) },
    { path: '.ai/core.adf', content: renderCoreAdf(facts, projectName) },
    { path: '.ai/state.adf', content: renderStateAdf(facts, projectName) },

    // Build config
    { path: 'package.json', content: renderPackageJson(facts, projectName, hints) },
    { path: 'tsconfig.json', content: renderTsConfig() },
    { path: 'wrangler.toml', content: renderWranglerToml(facts, projectName, hints) },

    // Source
    { path: 'src/index.ts', content: renderIndexTs(facts, hints) },

    // Tests
    { path: 'test/index.test.ts', content: renderTestFile(facts, projectName) },

    // Docs
    { path: 'README.md', content: renderReadme(facts, projectName, intention) },
  ];

  // Add domain-specific extra files (e.g. chatroom.ts for Durable Objects)
  for (const hint of hints) {
    if (hint.extraFiles) {
      files.push(...hint.extraFiles);
    }
  }

  const nextSteps = [
    `npm install`,
    `npx wrangler d1 create ${projectName}  # if D1 binding needed`,
    `npx wrangler dev`,
    `# First task: ${str(facts, 'first_task_name')} — ${str(facts, 'first_task_deliverable')}`,
  ];

  return { files, nextSteps };
}
