// ─── Stackbilt MCP Gateway ────────────────────────────────────
// Single entry point for all Stackbilt MCP tools.
// Routes tool calls to backend product workers via Service Bindings.
// Auth delegated to stackbilt-auth.

import type { GatewayEnv } from './types.js';
import { handleMcpRequest } from './gateway.js';

export default {
  async fetch(request: Request, env: GatewayEnv, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept, MCP-Session-Id, MCP-Protocol-Version',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // Route: /health, /mcp (POST/GET/DELETE), and root
    if (url.pathname === '/health' || url.pathname === '/mcp' || url.pathname === '/') {
      const response = await handleMcpRequest(request, env);
      // Add CORS headers to all responses
      response.headers.set('Access-Control-Allow-Origin', '*');
      response.headers.set('Access-Control-Expose-Headers', 'MCP-Session-Id');
      return response;
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
