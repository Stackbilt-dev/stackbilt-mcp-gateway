// Divergence Logger — Tier 2 vs Tier 3 Classification
//
// Captures every scaffold_create call where the Cerebras classification
// produced results. Stored to KV for offline pattern mining.
// Each entry enables the graduation loop: LLM insights → deterministic rules.
//
// Key format: scaffold:divergence:{timestamp}
// TTL: 90 days (enough for pattern mining, auto-expires)

import type { IntentClassification } from './intent-classifier.js';

export interface DivergenceRecord {
  timestamp: string;
  intention: string;
  // Tier 2: what Cerebras extracted
  tier2: {
    pattern?: string;
    entities?: string[];
    routes?: string[];
    integrations?: string[];
    constraints?: Record<string, boolean>;
    projectName?: string;
    confidence: number;
    ambiguous?: string[];
  };
  // Engine output: what the engine produced (Tier 3 regex + Tier 2 overrides merged)
  engine: {
    pattern?: string;
    routes?: string[];
    integrations?: string[];
    projectName?: string;
  };
  // Divergence summary: which fields differed between Tier 2 and engine regex baseline
  diverged: string[];
}

/**
 * Compute which fields the Tier 2 classifier provided that differ from
 * what the engine's regex would have produced on its own.
 */
function computeDivergence(
  tier2: IntentClassification,
  engineOutput: { pattern?: string; routes?: string[]; integrations?: string[] },
): string[] {
  const diverged: string[] = [];

  // Pattern divergence: did the classifier suggest a different pattern?
  // We can infer the regex baseline: if Tier 2 overrode pattern, the engine echoes the override.
  // The regex baseline for most free-text is "rest-api" unless specific keywords match.
  // Log the Tier 2 pattern for mining — actual divergence analysis happens offline.
  if (tier2.pattern && tier2.pattern !== 'rest-api') {
    diverged.push('pattern');
  }

  // Entity divergence: classifier extracted domain entities that regex can't
  if (tier2.entities && tier2.entities.length > 0) {
    diverged.push('entities');
  }

  // Route divergence: classifier found explicit routes
  if (tier2.routes && tier2.routes.length > 0) {
    diverged.push('routes');
  }

  // Integration divergence: classifier found integrations the regex might miss
  if (tier2.integrations && tier2.integrations.length > 0) {
    diverged.push('integrations');
  }

  // Constraint divergence: classifier determined bindings
  if (tier2.constraints) {
    const keys = Object.entries(tier2.constraints).filter(([, v]) => v === true).map(([k]) => k);
    if (keys.length > 0) diverged.push('constraints');
  }

  // Project name: classifier derived a meaningful name
  if (tier2.projectName) {
    diverged.push('projectName');
  }

  return diverged;
}

/**
 * Log a divergence record to KV. Non-blocking — errors are swallowed.
 */
export async function logDivergence(
  kv: KVNamespace,
  intention: string,
  tier2: IntentClassification,
  engineOutput: { pattern?: string; routes?: string[]; integrations?: string[]; project_name?: string },
): Promise<void> {
  try {
    const diverged = computeDivergence(tier2, engineOutput);

    // Only log if there's something interesting
    if (diverged.length === 0 && tier2.confidence > 0.9) return;

    const record: DivergenceRecord = {
      timestamp: new Date().toISOString(),
      intention: intention.slice(0, 500),
      tier2: {
        pattern: tier2.pattern,
        entities: tier2.entities,
        routes: tier2.routes,
        integrations: tier2.integrations,
        constraints: tier2.constraints as Record<string, boolean> | undefined,
        projectName: tier2.projectName,
        confidence: tier2.confidence,
        ambiguous: tier2.ambiguous,
      },
      engine: {
        pattern: engineOutput.pattern,
        routes: engineOutput.routes,
        integrations: engineOutput.integrations,
        projectName: engineOutput.project_name,
      },
      diverged,
    };

    const key = `scaffold:divergence:${Date.now()}`;
    await kv.put(key, JSON.stringify(record), { expirationTtl: 90 * 86400 });
  } catch {
    // Logging failure is non-fatal — never block scaffold generation
  }
}
