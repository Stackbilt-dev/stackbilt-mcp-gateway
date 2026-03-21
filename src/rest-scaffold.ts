// ─── REST Scaffold Endpoint ──────────────────────────────────
// POST /api/scaffold — REST API for the CLI.
// Uses Bearer token auth (sb_live_* API keys).
// Calls the same TarotScript → materializer pipeline as MCP scaffold_create.

import type { GatewayEnv } from './types.js';
import { extractBearerToken, validateBearerToken } from './auth.js';
import { materializeScaffold } from './scaffold-materializer.js';

interface ScaffoldRequest {
  description: string;
  project_type?: string;
  complexity?: string;
  modes?: string[];
  seed?: number;
}

export async function handleRestScaffold(
  request: Request,
  env: GatewayEnv,
): Promise<Response> {
  // Auth — require Bearer token
  const token = extractBearerToken(request);
  if (!token) {
    return Response.json({ error: 'Authorization required', code: 'UNAUTHORIZED' }, { status: 401 });
  }

  const auth = await validateBearerToken(token, env.AUTH_SERVICE);
  if (!auth.authenticated) {
    return Response.json({ error: auth.error, code: 'UNAUTHORIZED' }, { status: 401 });
  }

  // Parse body
  let body: ScaffoldRequest;
  try {
    body = await request.json() as ScaffoldRequest;
  } catch {
    return Response.json({ error: 'Invalid JSON body', code: 'BAD_REQUEST' }, { status: 400 });
  }

  if (!body.description || typeof body.description !== 'string') {
    return Response.json({ error: 'description is required', code: 'BAD_REQUEST' }, { status: 400 });
  }

  const intention = body.description;
  const state: Record<string, string> = {
    project_type: body.project_type ?? 'saas',
    complexity: body.complexity ?? 'moderate',
  };
  if (body.modes) state.modes = body.modes.join(',');

  // Call TarotScript scaffold-cast
  const tsBinding = env.TAROTSCRIPT;
  if (!tsBinding) {
    return Response.json({ error: 'TarotScript service not available', code: 'SERVICE_UNAVAILABLE' }, { status: 503 });
  }

  const tsResponse = await tsBinding.fetch(new Request('https://internal/run', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Gateway-Tenant-Id': auth.tenantId ?? '',
    },
    body: JSON.stringify({
      spreadType: 'scaffold-cast',
      querent: {
        id: auth.tenantId ?? 'cli',
        intention,
        state,
      },
      inscribe: true,
      ...(body.seed != null ? { seed: body.seed } : {}),
    }),
    signal: AbortSignal.timeout(30_000),
  }));

  if (!tsResponse.ok) {
    const err = await tsResponse.text().catch(() => `HTTP ${tsResponse.status}`);
    return Response.json({ error: `scaffold-cast failed: ${err}`, code: 'ENGINE_ERROR' }, { status: 502 });
  }

  const result = await tsResponse.json() as {
    output?: string[];
    facts?: Record<string, unknown>;
    receipt?: { hash: string; seed: number };
    analysis?: Record<string, unknown>;
  };

  // Materialize files from TarotScript facts — always use the materializer
  // (produces 9 deployment-ready files: wrangler.toml, .ai/ governance, typed handler, tests)
  let files: Array<{ path: string; content: string }> | undefined;
  let nextSteps: string[] | undefined;
  let fileSource: 'materializer' | 'none' = 'none';

  if (result.facts) {
    try {
      const materialized = materializeScaffold(result.facts, intention);
      files = materialized.files;
      nextSteps = materialized.nextSteps;
      fileSource = 'materializer';
    } catch {
      // Non-fatal
    }
  }

  if (files && !nextSteps) {
    const pkgFile = files.find(f => f.path === 'package.json');
    const projectName = pkgFile ? JSON.parse(pkgFile.content).name : 'my-project';
    nextSteps = [
      'npm install',
      `npx wrangler d1 create ${projectName}  # if D1 binding needed`,
      'npx wrangler dev',
    ];
  }

  return Response.json({
    files: files ?? [],
    fileSource,
    nextSteps: nextSteps ?? [],
    seed: result.receipt?.seed,
    receipt: result.receipt?.hash,
    facts: result.facts,
  });
}
