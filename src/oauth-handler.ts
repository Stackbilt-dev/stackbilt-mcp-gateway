// OAuth authorization handler (defaultHandler for OAuthProvider).
// Handles login, consent, and user registration.
// Identity verification delegated to stackbilt-auth via AUTH_SERVICE RPC.
// Ported from img-forge-mcp (ADR-039) — all redirects target mcp.stackbilt.dev.
import type { GatewayEnv } from './types.js';
import type { AuthRequest } from '@cloudflare/workers-oauth-provider';

// ── Feature gate: flip to true when ready to accept public signups ──
const PUBLIC_SIGNUPS_ENABLED = false;

// --- Shared styles ---

const SHARED_STYLES = `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Inter', system-ui, -apple-system, sans-serif; background: #09090b; color: #e5e5e5; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: #18181b; border: 1px solid #27272a; border-radius: 16px; padding: 2.5rem; width: 100%; max-width: 420px; }
    .logo { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem; }
    .logo svg { width: 28px; height: 28px; }
    .logo-text { font-size: 1.25rem; font-weight: 700; letter-spacing: -0.02em; }
    h1 { font-size: 1.5rem; font-weight: 600; letter-spacing: -0.02em; margin-bottom: 0.25rem; }
    .subtitle { color: #71717a; margin-bottom: 1.5rem; font-size: 0.875rem; line-height: 1.5; }
    .free-badge { display: inline-block; background: #052e16; color: #4ade80; padding: 0.2rem 0.6rem; border-radius: 9999px; font-size: 0.7rem; font-weight: 600; letter-spacing: 0.03em; text-transform: uppercase; margin-bottom: 1.25rem; }
    label { display: block; font-size: 0.8rem; color: #a1a1aa; margin-bottom: 0.3rem; font-weight: 500; }
    input[type="email"], input[type="password"], input[type="text"] { width: 100%; padding: 0.6rem 0.75rem; background: #09090b; border: 1px solid #27272a; border-radius: 8px; color: #e5e5e5; font-size: 0.875rem; margin-bottom: 0.875rem; transition: border-color 0.15s; }
    input:focus { outline: none; border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,0.1); }
    .btn-primary { width: 100%; padding: 0.65rem; background: #3b82f6; color: white; border: none; border-radius: 8px; font-size: 0.875rem; font-weight: 600; cursor: pointer; transition: background 0.15s; }
    .btn-primary:hover { background: #2563eb; }
    .divider { display: flex; align-items: center; gap: 0.75rem; margin: 1.25rem 0; color: #3f3f46; font-size: 0.75rem; }
    .divider::before, .divider::after { content: ''; flex: 1; height: 1px; background: #27272a; }
    .btn-oauth { width: 100%; padding: 0.6rem; background: #27272a; color: #e5e5e5; border: 1px solid #3f3f46; border-radius: 8px; font-size: 0.85rem; font-weight: 500; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 0.5rem; margin-bottom: 0.625rem; transition: background 0.15s, border-color 0.15s; }
    .btn-oauth:hover { background: #3f3f46; border-color: #52525b; }
    .btn-oauth svg { width: 18px; height: 18px; }
    .error { background: #450a0a; border: 1px solid #7f1d1d; color: #fca5a5; padding: 0.75rem; border-radius: 8px; margin-bottom: 1rem; font-size: 0.8rem; }
    .footer { text-align: center; margin-top: 1.25rem; font-size: 0.75rem; color: #52525b; }
    .footer a { color: #3b82f6; text-decoration: none; font-weight: 500; }
    .footer a:hover { text-decoration: underline; }
`;

const STACKBILT_LOGO = `<svg viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="2" y="8" width="24" height="5" rx="1.5" fill="#3b82f6"/>
  <rect x="5" y="15" width="18" height="5" rx="1.5" fill="#60a5fa"/>
  <rect x="8" y="22" width="12" height="4" rx="1.5" fill="#93c5fd"/>
  <rect x="8" y="2" width="12" height="4" rx="1.5" fill="#1d4ed8"/>
</svg>`;

const GITHUB_ICON = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.17 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.464-1.11-1.464-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.115 2.504.337 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.167 22 16.418 22 12c0-5.523-4.477-10-10-10z"/></svg>`;

const GOOGLE_ICON = `<svg viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>`;

// --- HTML templates ---

function renderLoginPage(
  oauthParams: string,
  error?: string,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in — Stackbilt</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>${SHARED_STYLES}</style>
</head>
<body>
  <div class="card">
    <div class="logo">${STACKBILT_LOGO}<span class="logo-text">Stackbilt</span></div>
    <p class="subtitle">Sign in to connect your AI tools</p>
    <div class="free-badge">Free tier included</div>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
    <form method="POST" action="/oauth/github">
      <input type="hidden" name="oauth_params" value="${escapeHtml(oauthParams)}">
      <button type="submit" class="btn-oauth">${GITHUB_ICON} Continue with GitHub</button>
    </form>
    <form method="POST" action="/oauth/google">
      <input type="hidden" name="oauth_params" value="${escapeHtml(oauthParams)}">
      <button type="submit" class="btn-oauth">${GOOGLE_ICON} Continue with Google</button>
    </form>
    <div class="divider">or sign in with email</div>
    <form method="POST" action="/login">
      <input type="hidden" name="oauth_params" value="${escapeHtml(oauthParams)}">
      <label for="email">Email</label>
      <input type="email" id="email" name="email" required autocomplete="email">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required autocomplete="current-password">
      <button type="submit" class="btn-primary">Sign in</button>
    </form>
    <div class="footer">
      Don't have an account? <a href="/signup?oauth_params=${escapeHtml(oauthParams)}">Sign up</a>
    </div>
  </div>
</body>
</html>`;
}

function renderSignupPage(
  oauthParams: string,
  error?: string,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign up — Stackbilt</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>${SHARED_STYLES}</style>
</head>
<body>
  <div class="card">
    <div class="logo">${STACKBILT_LOGO}<span class="logo-text">Stackbilt</span></div>
    <p class="subtitle">Create your account to start building</p>
    <div class="free-badge">Free tier included</div>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
    <form method="POST" action="/oauth/github">
      <input type="hidden" name="oauth_params" value="${escapeHtml(oauthParams)}">
      <button type="submit" class="btn-oauth">${GITHUB_ICON} Continue with GitHub</button>
    </form>
    <form method="POST" action="/oauth/google">
      <input type="hidden" name="oauth_params" value="${escapeHtml(oauthParams)}">
      <button type="submit" class="btn-oauth">${GOOGLE_ICON} Continue with Google</button>
    </form>
    <div class="divider">or sign up with email</div>
    <form method="POST" action="/signup">
      <input type="hidden" name="oauth_params" value="${escapeHtml(oauthParams)}">
      <label for="name">Name</label>
      <input type="text" id="name" name="name" required autocomplete="name">
      <label for="email">Email</label>
      <input type="email" id="email" name="email" required autocomplete="email">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required autocomplete="new-password" minlength="8">
      <button type="submit" class="btn-primary">Create account</button>
    </form>
    <div class="footer">
      Already have an account? <a href="/authorize?oauth_params=${escapeHtml(oauthParams)}">Sign in</a>
    </div>
  </div>
</body>
</html>`;
}

function renderConsentPage(
  clientName: string,
  scopes: string[],
  oauthParams: string,
  identityToken: string,
  userEmail: string,
): string {
  const scopeLabels: Record<string, string> = {
    generate: 'Generate content (images, architecture flows)',
    read: 'View resources and check status',
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize — Stackbilt</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    ${SHARED_STYLES}
    .user-badge { display: inline-block; background: #172554; color: #93c5fd; padding: 0.25rem 0.75rem; border-radius: 9999px; font-size: 0.75rem; margin-bottom: 1.5rem; }
    .scopes { list-style: none; margin-bottom: 1.5rem; }
    .scopes li { padding: 0.6rem 0; border-bottom: 1px solid #27272a; font-size: 0.85rem; display: flex; align-items: flex-start; gap: 0.5rem; }
    .scopes li:last-child { border-bottom: none; }
    .scope-check { color: #4ade80; flex-shrink: 0; margin-top: 0.1rem; }
    .scope-name { font-weight: 500; }
    .scope-desc { color: #71717a; font-size: 0.8rem; }
    .actions { display: flex; gap: 0.75rem; }
    .btn { flex: 1; padding: 0.65rem; border: none; border-radius: 8px; font-size: 0.875rem; font-weight: 600; cursor: pointer; transition: background 0.15s; }
    .btn-approve { background: #3b82f6; color: white; }
    .btn-approve:hover { background: #2563eb; }
    .btn-deny { background: #27272a; color: #a1a1aa; border: 1px solid #3f3f46; }
    .btn-deny:hover { background: #3f3f46; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">${STACKBILT_LOGO}<span class="logo-text">Stackbilt</span></div>
    <h1 style="margin-top:1rem;">Authorize access</h1>
    <p class="subtitle"><strong style="color:#e5e5e5;">${escapeHtml(clientName)}</strong> wants to access your Stackbilt account</p>
    <div class="user-badge">${escapeHtml(userEmail)}</div>
    <ul class="scopes">
      ${scopes
        .map(
          (s) =>
            `<li><span class="scope-check">&#10003;</span><div><span class="scope-name">${escapeHtml(s)}</span><br><span class="scope-desc">${escapeHtml(scopeLabels[s] || s)}</span></div></li>`,
        )
        .join('')}
    </ul>
    <div class="actions">
      <form method="POST" action="/authorize" style="flex:1;display:flex;">
        <input type="hidden" name="oauth_params" value="${escapeHtml(oauthParams)}">
        <input type="hidden" name="identity_token" value="${escapeHtml(identityToken)}">
        <input type="hidden" name="action" value="deny">
        <button type="submit" class="btn btn-deny" style="width:100%;">Deny</button>
      </form>
      <form method="POST" action="/authorize" style="flex:1;display:flex;">
        <input type="hidden" name="oauth_params" value="${escapeHtml(oauthParams)}">
        <input type="hidden" name="identity_token" value="${escapeHtml(identityToken)}">
        <input type="hidden" name="action" value="approve">
        <button type="submit" class="btn btn-approve" style="width:100%;">Approve</button>
      </form>
    </div>
  </div>
</body>
</html>`;
}

// --- HTML escaping (Security Constitution: prevent XSS in rendered pages) ---

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// --- Signed identity token (HMAC-SHA256, short-lived) ---
// Carries userId + email through login -> consent without cookies.

interface UserIdentity {
  userId: string;
  email: string;
  name: string;
  exp: number;
}

export async function signIdentityToken(
  secret: string,
  identity: Omit<UserIdentity, 'exp'>,
): Promise<string> {
  const payload: UserIdentity = { ...identity, exp: Date.now() + 300_000 }; // 5 min TTL
  const data = JSON.stringify(payload);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const sigHex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return btoa(data) + '.' + sigHex;
}

export async function verifyIdentityToken(
  secret: string,
  token: string,
): Promise<UserIdentity | null> {
  const dotIdx = token.indexOf('.');
  if (dotIdx < 0) return null;

  const dataB64 = token.slice(0, dotIdx);
  const sigHex = token.slice(dotIdx + 1);
  if (!dataB64 || !sigHex) return null;

  let data: string;
  try {
    data = atob(dataB64);
  } catch {
    return null;
  }
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const sigBytes = new Uint8Array(sigHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
  const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(data));
  if (!valid) return null;

  let identity: UserIdentity;
  try {
    identity = JSON.parse(data);
  } catch {
    return null;
  }
  if (identity.exp < Date.now()) return null;

  return identity;
}

// --- Auto-provision tenant for OAuth users ---

async function ensureTenantExists(env: GatewayEnv, userId: string): Promise<void> {
  try {
    await env.AUTH_SERVICE.provisionTenant({ userId, source: 'oauth' });
  } catch (error) {
    console.error(
      'Tenant auto-provision failed:',
      error instanceof Error ? error.message : String(error),
    );
  }
}

// --- Helper: build authorize redirect URL ---

function buildAuthorizeRedirect(
  env: GatewayEnv,
  oauthReqInfo: AuthRequest,
  identityToken: string,
): string {
  const authorizeUrl = new URL('/authorize', env.API_BASE_URL);
  authorizeUrl.searchParams.set('response_type', oauthReqInfo.responseType);
  authorizeUrl.searchParams.set('client_id', oauthReqInfo.clientId);
  authorizeUrl.searchParams.set('redirect_uri', oauthReqInfo.redirectUri);
  authorizeUrl.searchParams.set('scope', oauthReqInfo.scope.join(' '));
  authorizeUrl.searchParams.set('state', oauthReqInfo.state);
  if (oauthReqInfo.codeChallenge) {
    authorizeUrl.searchParams.set('code_challenge', oauthReqInfo.codeChallenge);
  }
  if (oauthReqInfo.codeChallengeMethod) {
    authorizeUrl.searchParams.set('code_challenge_method', oauthReqInfo.codeChallengeMethod);
  }
  authorizeUrl.searchParams.set('identity_token', identityToken);
  return authorizeUrl.toString();
}

// --- "Coming soon" page when signups are gated ---

function renderComingSoonPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Coming Soon — Stackbilt</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>${SHARED_STYLES}</style>
</head>
<body>
  <div class="card" style="text-align:center;">
    <div class="logo" style="justify-content:center;">${STACKBILT_LOGO}<span class="logo-text">Stackbilt</span></div>
    <h1 style="margin-top:1rem;">Currently Building</h1>
    <p class="subtitle">We're heads-down building the platform. Public access is coming soon.</p>
    <a href="https://github.com/Stackbilt-dev" class="btn-oauth" style="text-decoration:none;margin-top:0.5rem;">${GITHUB_ICON} Follow on GitHub</a>
    <div class="footer" style="margin-top:1.5rem;">
      <a href="https://stackbilt.dev">Back to Stackbilt</a>
    </div>
  </div>
</body>
</html>`;
}

// --- Route handler ---

const handler: ExportedHandler<GatewayEnv> = {
  async fetch(
    request: Request,
    env: GatewayEnv,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // Gate all auth pages when signups are disabled
    if (!PUBLIC_SIGNUPS_ENABLED) {
      const gatedPaths = [
        '/authorize',
        '/login',
        '/signup',
        '/oauth/github',
        '/oauth/google',
        '/oauth/callback',
      ];
      if (gatedPaths.includes(url.pathname)) {
        return new Response(renderComingSoonPage(), {
          headers: { 'Content-Type': 'text/html' },
        });
      }
    }

    // GET /authorize -- show login or consent
    if (url.pathname === '/authorize' && request.method === 'GET') {
      return handleGetAuthorize(request, env);
    }

    // POST /authorize -- consent approval/denial
    if (url.pathname === '/authorize' && request.method === 'POST') {
      return handlePostAuthorize(request, env);
    }

    // POST /login -- form login via stackbilt-auth RPC
    if (url.pathname === '/login' && request.method === 'POST') {
      return handleLogin(request, env);
    }

    // GET /signup -- show signup form
    if (url.pathname === '/signup' && request.method === 'GET') {
      const oauthParams = url.searchParams.get('oauth_params') || '';
      return new Response(renderSignupPage(oauthParams), {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    // POST /signup -- create account via stackbilt-auth RPC
    if (url.pathname === '/signup' && request.method === 'POST') {
      return handleSignup(request, env);
    }

    // POST /oauth/github -- initiate GitHub OAuth via stackbilt-auth
    if (url.pathname === '/oauth/github' && request.method === 'POST') {
      return handleSocialOAuth(request, env, 'github');
    }

    // POST /oauth/google -- initiate Google OAuth via stackbilt-auth
    if (url.pathname === '/oauth/google' && request.method === 'POST') {
      return handleSocialOAuth(request, env, 'google');
    }

    // GET /oauth/callback -- handle social OAuth callback
    if (url.pathname === '/oauth/callback' && request.method === 'GET') {
      return handleSocialOAuthCallback(request, env);
    }

    return new Response('Not found', { status: 404 });
  },
};

export default handler;

// --- Handler implementations ---

async function handleGetAuthorize(request: Request, env: GatewayEnv): Promise<Response> {
  const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  const oauthParams = btoa(JSON.stringify(oauthReqInfo));

  // Check for identity token (set after successful login/signup)
  const url = new URL(request.url);
  const identityToken = url.searchParams.get('identity_token');

  if (identityToken) {
    const identity = await verifyIdentityToken(env.SERVICE_BINDING_SECRET, identityToken);
    if (identity) {
      // Authenticated -- show consent screen
      const clientInfo = await env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
      const clientName = clientInfo?.clientName || oauthReqInfo.clientId;
      return new Response(
        renderConsentPage(clientName, oauthReqInfo.scope, oauthParams, identityToken, identity.email),
        { headers: { 'Content-Type': 'text/html' } },
      );
    }
    // Token invalid/expired -- fall through to login
  }

  // Not authenticated -- show login form
  return new Response(renderLoginPage(oauthParams), {
    headers: { 'Content-Type': 'text/html' },
  });
}

async function handlePostAuthorize(request: Request, env: GatewayEnv): Promise<Response> {
  const formData = await request.formData();
  const action = formData.get('action') as string;
  const oauthParamsB64 = formData.get('oauth_params') as string;
  const identityTokenStr = formData.get('identity_token') as string;

  if (!oauthParamsB64) {
    return new Response('Missing OAuth parameters', { status: 400 });
  }

  let oauthReqInfo: AuthRequest;
  try {
    oauthReqInfo = JSON.parse(atob(oauthParamsB64));
  } catch {
    return Response.json({ error: 'Malformed OAuth parameters' }, { status: 400 });
  }

  // Verify identity token (HMAC-signed, 5-min TTL)
  if (!identityTokenStr) {
    return new Response(
      renderLoginPage(oauthParamsB64, 'Session expired. Please sign in again.'),
      { headers: { 'Content-Type': 'text/html' } },
    );
  }

  const identity = await verifyIdentityToken(env.SERVICE_BINDING_SECRET, identityTokenStr);
  if (!identity) {
    return new Response(
      renderLoginPage(oauthParamsB64, 'Session expired. Please sign in again.'),
      { headers: { 'Content-Type': 'text/html' } },
    );
  }

  if (action === 'deny') {
    const redirectUrl = new URL(oauthReqInfo.redirectUri);
    redirectUrl.searchParams.set('error', 'access_denied');
    redirectUrl.searchParams.set('error_description', 'User denied the authorization request');
    if (oauthReqInfo.state) {
      redirectUrl.searchParams.set('state', oauthReqInfo.state);
    }
    return Response.redirect(redirectUrl.toString(), 302);
  }

  // Approve -- complete the OAuth authorization
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReqInfo,
    userId: identity.userId,
    scope: oauthReqInfo.scope,
    metadata: {
      authorizedAt: new Date().toISOString(),
      userEmail: identity.email,
    },
    props: {
      userId: identity.userId,
      email: identity.email,
      name: identity.name,
    },
  });

  return Response.redirect(redirectTo, 302);
}

async function handleLogin(request: Request, env: GatewayEnv): Promise<Response> {
  const formData = await request.formData();
  const email = formData.get('email') as string;
  const password = formData.get('password') as string;
  const oauthParams = formData.get('oauth_params') as string;

  if (!email || !password) {
    return new Response(
      renderLoginPage(oauthParams || '', 'Email and password are required.'),
      { headers: { 'Content-Type': 'text/html' } },
    );
  }

  // Authenticate via stackbilt-auth RPC
  const result = await env.AUTH_SERVICE.authenticateUser(email, password);

  if (!result.valid) {
    return new Response(
      renderLoginPage(oauthParams || '', 'Invalid email or password.'),
      { headers: { 'Content-Type': 'text/html' } },
    );
  }

  // Auto-provision tenant (idempotent -- returns existing if found)
  await ensureTenantExists(env, result.userId!);

  // Create signed identity token to carry through consent flow
  const identityToken = await signIdentityToken(env.SERVICE_BINDING_SECRET, {
    userId: result.userId!,
    email: result.email!,
    name: result.name || result.email!,
  });

  let oauthReqInfo: AuthRequest;
  try {
    oauthReqInfo = JSON.parse(atob(oauthParams));
  } catch {
    return Response.json({ error: 'Malformed OAuth parameters' }, { status: 400 });
  }

  return Response.redirect(buildAuthorizeRedirect(env, oauthReqInfo, identityToken), 302);
}

async function handleSignup(request: Request, env: GatewayEnv): Promise<Response> {
  const formData = await request.formData();
  const name = formData.get('name') as string;
  const email = formData.get('email') as string;
  const password = formData.get('password') as string;
  const oauthParams = formData.get('oauth_params') as string;

  if (!name || !email || !password) {
    return new Response(
      renderSignupPage(oauthParams || '', 'All fields are required.'),
      { headers: { 'Content-Type': 'text/html' } },
    );
  }

  if (password.length < 8) {
    return new Response(
      renderSignupPage(oauthParams || '', 'Password must be at least 8 characters.'),
      { headers: { 'Content-Type': 'text/html' } },
    );
  }

  // Register via stackbilt-auth RPC
  const result = await env.AUTH_SERVICE.registerUser(name, email, password);

  if (!result.valid) {
    const message =
      result.error === 'EMAIL_EXISTS'
        ? 'An account with this email already exists.'
        : 'Sign up failed. Please try again.';
    return new Response(renderSignupPage(oauthParams || '', message), {
      headers: { 'Content-Type': 'text/html' },
    });
  }

  // Auto-provision tenant for new user (creates tenant + quota periods)
  await ensureTenantExists(env, result.userId!);

  // Create signed identity token
  const identityToken = await signIdentityToken(env.SERVICE_BINDING_SECRET, {
    userId: result.userId!,
    email: result.email!,
    name: result.name || result.email!,
  });

  let oauthReqInfo: AuthRequest;
  try {
    oauthReqInfo = JSON.parse(atob(oauthParams));
  } catch {
    return Response.json({ error: 'Malformed OAuth parameters' }, { status: 400 });
  }

  return Response.redirect(buildAuthorizeRedirect(env, oauthReqInfo, identityToken), 302);
}

// --- Social OAuth (GitHub / Google) ---
// Initiates OAuth flow by redirecting to auth.stackbilt.dev Better Auth endpoints.
// After social auth completes, callback carries identity back to the MCP OAuth flow.

async function handleSocialOAuth(
  request: Request,
  env: GatewayEnv,
  provider: 'github' | 'google',
): Promise<Response> {
  const formData = await request.formData();
  const oauthParams = (formData.get('oauth_params') as string) || '';

  // Store oauth_params in KV so we can retrieve them after the social callback
  const stateKey = crypto.randomUUID();
  await env.OAUTH_KV.put(`social_state:${stateKey}`, oauthParams, { expirationTtl: 300 });

  // Redirect to auth.stackbilt.dev social bridge
  const callbackUrl = `${env.API_BASE_URL}/oauth/callback`;
  const bridgeUrl = `https://auth.stackbilt.dev/social-bridge?provider=${provider}&return_url=${encodeURIComponent(callbackUrl)}&state=${stateKey}`;

  return Response.redirect(bridgeUrl, 302);
}

async function handleSocialOAuthCallback(request: Request, env: GatewayEnv): Promise<Response> {
  const url = new URL(request.url);
  const stateKey = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    return new Response(renderLoginPage('', 'Social sign-in failed. Please try again.'), {
      headers: { 'Content-Type': 'text/html' },
    });
  }

  if (!stateKey || !code) {
    return new Response(renderLoginPage('', 'Missing authentication data. Please try again.'), {
      headers: { 'Content-Type': 'text/html' },
    });
  }

  // Retrieve stored oauth_params
  const oauthParams = await env.OAUTH_KV.get(`social_state:${stateKey}`);
  await env.OAUTH_KV.delete(`social_state:${stateKey}`);

  if (!oauthParams) {
    return new Response(renderLoginPage('', 'Session expired. Please try again.'), {
      headers: { 'Content-Type': 'text/html' },
    });
  }

  // Exchange the one-time code for user identity via auth service RPC
  const result = await env.AUTH_SERVICE.exchangeSocialCode(code);

  if (!result.valid) {
    return new Response(
      renderLoginPage(oauthParams, 'Social sign-in failed. Please try again.'),
      { headers: { 'Content-Type': 'text/html' } },
    );
  }

  // Auto-provision tenant (idempotent)
  await ensureTenantExists(env, result.userId!);

  // Create signed identity token to carry through consent flow
  const identityToken = await signIdentityToken(env.SERVICE_BINDING_SECRET, {
    userId: result.userId!,
    email: result.email!,
    name: result.name || result.email!,
  });

  let oauthReqInfo: AuthRequest;
  try {
    oauthReqInfo = JSON.parse(atob(oauthParams));
  } catch {
    return Response.json({ error: 'Malformed OAuth parameters' }, { status: 400 });
  }

  return Response.redirect(buildAuthorizeRedirect(env, oauthReqInfo, identityToken), 302);
}
