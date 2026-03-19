import { describe, it, expect } from 'vitest';
import {
  toBackendToolName,
  toGatewayToolName,
  buildAggregatedCatalog,
  validateToolArguments,
  validateInputSchema,
} from '../src/tool-registry.js';

describe('toBackendToolName', () => {
  it('maps image.generate → generate_image', () => {
    expect(toBackendToolName('image.generate')).toBe('generate_image');
  });

  it('maps image.list_models → list_models', () => {
    expect(toBackendToolName('image.list_models')).toBe('list_models');
  });

  it('maps image.check_job → check_job', () => {
    expect(toBackendToolName('image.check_job')).toBe('check_job');
  });

  it('passes through flow.create → flow.create (backend uses same name)', () => {
    expect(toBackendToolName('flow.create')).toBe('flow.create');
  });

  it('returns input for unknown tool', () => {
    expect(toBackendToolName('unknown.tool')).toBe('unknown.tool');
  });
});

describe('toGatewayToolName', () => {
  it('maps generate_image with image prefix → image.generate', () => {
    expect(toGatewayToolName('generate_image', 'image')).toBe('image.generate');
  });

  it('maps flow.create with flow prefix → flow.create', () => {
    expect(toGatewayToolName('flow.create', 'flow')).toBe('flow.create');
  });

  it('returns null for unknown backend name', () => {
    expect(toGatewayToolName('nonexistent', 'image')).toBeNull();
  });

  it('returns null for unknown prefix', () => {
    expect(toGatewayToolName('generate_image', 'unknown')).toBeNull();
  });
});

describe('buildAggregatedCatalog', () => {
  it('returns all 13 tools', () => {
    const catalog = buildAggregatedCatalog();
    expect(catalog).toHaveLength(13);
  });

  it('every tool has a risk level annotation', () => {
    const catalog = buildAggregatedCatalog();
    for (const tool of catalog) {
      expect(tool.annotations.riskLevel, `${tool.name} missing riskLevel`).toBeTruthy();
    }
  });

  it('readOnlyHint matches risk level', () => {
    const catalog = buildAggregatedCatalog();
    for (const tool of catalog) {
      if (tool.annotations.riskLevel === 'READ_ONLY') {
        expect(tool.annotations.readOnlyHint, `${tool.name} should be readOnly`).toBe(true);
      } else {
        expect(tool.annotations.readOnlyHint, `${tool.name} should not be readOnly`).toBe(false);
      }
    }
  });

  it('destructiveHint only set for DESTRUCTIVE risk level', () => {
    const catalog = buildAggregatedCatalog();
    for (const tool of catalog) {
      if (tool.annotations.riskLevel === 'DESTRUCTIVE') {
        expect(tool.annotations.destructiveHint).toBe(true);
      } else {
        expect(tool.annotations.destructiveHint).toBe(false);
      }
    }
  });

  it('tool names follow prefix.name convention', () => {
    const catalog = buildAggregatedCatalog();
    for (const tool of catalog) {
      expect(tool.name).toMatch(/^(flow|image)\./);
    }
  });

  it('every tool has a real description (not placeholder)', () => {
    const catalog = buildAggregatedCatalog();
    for (const tool of catalog) {
      expect(tool.description, `${tool.name} has placeholder description`).not.toContain('Proxied tool');
      expect(tool.description.length, `${tool.name} description too short`).toBeGreaterThan(20);
    }
  });

  it('image.generate has proper inputSchema with prompt', () => {
    const catalog = buildAggregatedCatalog();
    const gen = catalog.find(t => t.name === 'image.generate')!;
    expect(gen).toBeDefined();
    const props = gen.inputSchema['properties'] as Record<string, unknown>;
    expect(props['prompt']).toBeDefined();
    expect(props['quality_tier']).toBeDefined();
    expect(gen.inputSchema['required']).toContain('prompt');
  });

  it('flow.create has proper inputSchema with policy', () => {
    const catalog = buildAggregatedCatalog();
    const create = catalog.find(t => t.name === 'flow.create')!;
    expect(create).toBeDefined();
    const props = create.inputSchema['properties'] as Record<string, unknown>;
    expect(props['policy']).toBeDefined();
    expect(create.inputSchema['required']).toContain('policy');
  });
});

describe('validateToolArguments', () => {
  it('accepts valid object arguments', () => {
    expect(validateToolArguments({ prompt: 'test' }, { type: 'object' })).toEqual({ valid: true });
  });

  it('accepts undefined when no required fields', () => {
    expect(validateToolArguments(undefined, { type: 'object' })).toEqual({ valid: true });
  });

  it('rejects undefined when required fields exist', () => {
    const result = validateToolArguments(undefined, { type: 'object', required: ['name'] });
    expect(result.valid).toBe(false);
  });

  it('rejects array arguments', () => {
    const result = validateToolArguments([1, 2, 3], { type: 'object' });
    expect(result.valid).toBe(false);
  });

  it('rejects string arguments', () => {
    const result = validateToolArguments('not an object', { type: 'object' });
    expect(result.valid).toBe(false);
  });
});

describe('validateInputSchema', () => {
  it('accepts valid schema', () => {
    expect(validateInputSchema({ type: 'object', properties: {} })).toBe(true);
  });

  it('rejects null', () => {
    expect(validateInputSchema(null)).toBe(false);
  });

  it('rejects array', () => {
    expect(validateInputSchema([])).toBe(false);
  });

  it('rejects schema without type: object', () => {
    expect(validateInputSchema({ type: 'string' })).toBe(false);
  });
});
