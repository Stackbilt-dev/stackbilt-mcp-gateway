// Tier 2 Intent Classification
//
// Lightweight LLM pre-pass that extracts structured fields from free-text
// scaffold intentions. Feeds the same BuildRequest contract as explicit
// params (Tier 1) and regex fallback (Tier 3).
//
// The composer doesn't know or care which tier produced the input.
// One contract, multiple input paths, zero ambiguity at composition layer.

export interface IntentClassification {
  pattern?: string;
  entities?: string[];
  routes?: string[];
  integrations?: string[];
  constraints?: {
    needsDatabase?: boolean;
    needsStorage?: boolean;
    needsCache?: boolean;
    needsQueue?: boolean;
    needsCron?: boolean;
    needsRealtime?: boolean;
    needsAuth?: boolean;
  };
  projectName?: string;
  confidence: number;
  ambiguous?: string[];
}

const CLASSIFICATION_PROMPT = `You are a scaffold intent classifier for Cloudflare Workers projects.

Given a project description, extract structured fields. Return ONLY valid JSON, no explanation.

Fields:
- pattern: "discord-bot" | "stripe-webhook" | "github-webhook" | "mcp-server" | "queue-consumer" | "cron-worker" | "rest-api"
- entities: domain nouns that would be database tables (e.g., ["tickets", "users", "boards"]). NOT infrastructure words.
- routes: explicit API paths mentioned (e.g., ["/api/tickets", "/ingest", "/ask"])
- integrations: security/auth mechanisms needed (e.g., ["jwt", "ed25519", "hmac", "oauth", "rate-limiting"])
- constraints: which Cloudflare bindings are needed
  - needsDatabase: true if D1/SQL/persistence mentioned
  - needsStorage: true if R2/file uploads/images/attachments mentioned (NOT "file path" or "file system")
  - needsCache: true if KV/cache/fast reads mentioned
  - needsQueue: true if message queue/async processing mentioned
  - needsCron: true if scheduled/cron/periodic mentioned
  - needsRealtime: true if WebSocket/Durable Objects/live updates mentioned
  - needsAuth: true if auth/login/JWT/OAuth mentioned
- projectName: a kebab-case project name derived from the core concept (3-5 words max)
- confidence: 0-1 how confident you are in the overall classification
- ambiguous: array of field names where you're uncertain (e.g., ["needsStorage"] if "file" is mentioned ambiguously)

Example input: "Multi-tenant helpdesk API. D1 for tickets and organizations. R2 for attachments. JWT auth."
Example output: {"pattern":"rest-api","entities":["tickets","organizations"],"routes":[],"integrations":["jwt"],"constraints":{"needsDatabase":true,"needsStorage":true,"needsAuth":true},"projectName":"helpdesk-api","confidence":0.95,"ambiguous":[]}`;

/**
 * Classify a scaffold intention using Workers AI.
 * Returns structured fields that map directly to BuildRequest.
 * Falls back gracefully — returns null if AI unavailable or confidence too low.
 */
export async function classifyIntention(
  intention: string,
  ai: Ai,
  confidenceThreshold: number = 0.7,
): Promise<IntentClassification | null> {
  try {
    const response = await (ai as any).run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        { role: 'system', content: CLASSIFICATION_PROMPT },
        { role: 'user', content: intention },
      ],
      max_tokens: 512,
      temperature: 0,
    });

    const text = typeof response === 'string'
      ? response
      : (response as { response?: string }).response ?? '';

    // Extract JSON from response (may have markdown fences)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as IntentClassification;

    // Validate confidence threshold
    if (typeof parsed.confidence !== 'number' || parsed.confidence < confidenceThreshold) {
      return null;
    }

    // Sanitize: ensure arrays are arrays, booleans are booleans
    return {
      pattern: typeof parsed.pattern === 'string' ? parsed.pattern : undefined,
      entities: Array.isArray(parsed.entities) ? parsed.entities : undefined,
      routes: Array.isArray(parsed.routes) ? parsed.routes : undefined,
      integrations: Array.isArray(parsed.integrations) ? parsed.integrations : undefined,
      constraints: parsed.constraints && typeof parsed.constraints === 'object' ? parsed.constraints : undefined,
      projectName: typeof parsed.projectName === 'string' ? parsed.projectName : undefined,
      confidence: parsed.confidence,
      ambiguous: Array.isArray(parsed.ambiguous) ? parsed.ambiguous : undefined,
    };
  } catch {
    // AI unavailable or parse failure — fall through to Tier 3
    return null;
  }
}
