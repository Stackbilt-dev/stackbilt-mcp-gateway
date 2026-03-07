// ─── Stackbilt MCP Gateway ────────────────────────────────────
// Single entry point for all Stackbilt MCP tools.
// Routes tool calls to backend product workers via Service Bindings.
// OAuth 2.1 with PKCE via @cloudflare/workers-oauth-provider.
// Auth delegated to stackbilt-auth.

import OAuthProvider from '@cloudflare/workers-oauth-provider';
import type { GatewayEnv } from './types.js';
import { handleMcpRequest } from './gateway.js';
import oauthHandler from './oauth-handler.js';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, Accept, MCP-Session-Id, MCP-Protocol-Version',
  'Access-Control-Expose-Headers': 'MCP-Session-Id',
  'Access-Control-Max-Age': '86400',
};

function addCorsHeaders(response: Response): Response {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
}

const oauthProvider = new OAuthProvider<GatewayEnv>({
  apiRoute: '/mcp',
  apiHandler: {
    fetch: async (request: Request, env: GatewayEnv, _ctx: ExecutionContext) => {
      const response = await handleMcpRequest(request, env);
      return addCorsHeaders(response);
    },
  },
  defaultHandler: oauthHandler,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  scopesSupported: ['generate', 'read'],
  accessTokenTTL: 3600,
  refreshTokenTTL: 2592000,
});

export default {
  async fetch(request: Request, env: GatewayEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Health check — bypass OAuthProvider
    if (url.pathname === '/health') {
      const response = await handleMcpRequest(request, env);
      return addCorsHeaders(response);
    }

    return oauthProvider.fetch(request, env, ctx);
  },
};
