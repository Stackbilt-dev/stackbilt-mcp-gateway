import { describe, it, expect } from 'vitest';
import { resolveRoute, getToolRiskLevel, ROUTE_TABLE, TOOL_RISK_LEVELS } from '../src/route-table.js';

describe('resolveRoute', () => {
  it('resolves flow.create to Stackbilder backend', () => {
    const result = resolveRoute('flow.create');
    expect(result).not.toBeNull();
    expect(result!.route.prefix).toBe('flow');
    expect(result!.route.product).toBe('Stackbilder');
    expect(result!.route.bindingKey).toBe('STACKBILDER');
    expect(result!.backendToolName).toBe('create');
  });

  it('resolves image.generate to img-forge backend', () => {
    const result = resolveRoute('image.generate');
    expect(result).not.toBeNull();
    expect(result!.route.prefix).toBe('image');
    expect(result!.route.product).toBe('img-forge');
    expect(result!.route.bindingKey).toBe('IMG_FORGE');
  });

  it('returns null for unknown prefix', () => {
    expect(resolveRoute('unknown.tool')).toBeNull();
  });

  it('returns null for tool name without dot separator', () => {
    expect(resolveRoute('flowcreate')).toBeNull();
  });

  it('resolves all flow.* tools', () => {
    const flowTools = ['flow.create', 'flow.status', 'flow.summary', 'flow.quality', 'flow.governance', 'flow.advance', 'flow.recover'];
    for (const name of flowTools) {
      const result = resolveRoute(name);
      expect(result, `Expected ${name} to resolve`).not.toBeNull();
      expect(result!.route.prefix).toBe('flow');
    }
  });

  it('resolves all image.* tools', () => {
    const imageTools = ['image.generate', 'image.list_models', 'image.check_job'];
    for (const name of imageTools) {
      const result = resolveRoute(name);
      expect(result, `Expected ${name} to resolve`).not.toBeNull();
      expect(result!.route.prefix).toBe('image');
    }
  });
});

describe('getToolRiskLevel', () => {
  it('returns READ_ONLY for flow.status', () => {
    expect(getToolRiskLevel('flow.status')).toBe('READ_ONLY');
  });

  it('returns LOCAL_MUTATION for flow.create', () => {
    expect(getToolRiskLevel('flow.create')).toBe('LOCAL_MUTATION');
  });

  it('returns EXTERNAL_MUTATION for image.generate', () => {
    expect(getToolRiskLevel('image.generate')).toBe('EXTERNAL_MUTATION');
  });

  it('returns undefined for unknown tool', () => {
    expect(getToolRiskLevel('unknown.tool')).toBeUndefined();
  });

  it('every tool in ROUTE_TABLE has a risk level', () => {
    const allToolNames = Object.keys(TOOL_RISK_LEVELS);
    expect(allToolNames.length).toBeGreaterThan(0);
    for (const name of allToolNames) {
      expect(resolveRoute(name), `${name} should resolve to a route`).not.toBeNull();
    }
  });
});

describe('ROUTE_TABLE', () => {
  it('has exactly 2 entries', () => {
    expect(ROUTE_TABLE).toHaveLength(2);
  });

  it('each entry has required fields', () => {
    for (const route of ROUTE_TABLE) {
      expect(route.prefix).toBeTruthy();
      expect(route.product).toBeTruthy();
      expect(route.bindingKey).toBeTruthy();
      expect(route.mcpPath).toBeTruthy();
    }
  });
});
