import { describe, it, expect } from 'vitest';
import { materializeScaffold } from '../src/scaffold-materializer.js';

const facts = {
  project_type: 'api',
  complexity: 'standard',
  requirement_name: 'User Profile',
  requirement_element: 'User',
  requirement_orientation: 'upright',
  requirement_priority: 'P0',
  requirement_effort: 'small',
  requirement_acceptance:
    'profile edits saved without full reload,avatar resized server-side,email change triggers verification',
  interface_name: 'Stack',
  interface_element: 'Flow',
  interface_orientation: 'upright',
  interface_regions: 'content',
  interface_grid: '1fr',
  threat_name: 'Authentication Bypass',
  threat_element: 'Security',
  threat_orientation: 'upright',
  threat_likelihood: 'medium',
  threat_impact: 'critical',
  threat_mitigation: 'centralised auth middleware on every protected route',
  runtime_name: 'Workers for Platforms',
  runtime_element: 'Edge',
  runtime_orientation: 'upright',
  runtime_tier: 'blessed',
  runtime_traits: ['multi-tenant', 'isolation', 'dispatch', 'user-scripts'],
  test_plan_name: 'Mock Dependency Test',
  test_plan_element: 'Isolation',
  test_plan_orientation: 'reversed',
  test_plan_framework: 'vitest',
  test_plan_ci_stage: 'pre-commit',
  test_plan_coverage_target: '90',
  first_task_name: 'Search Feature',
  first_task_element: 'Build',
  first_task_orientation: 'upright',
  first_task_estimate: '5',
  first_task_complexity: 'medium',
  first_task_deliverable:
    'search input with debounce, filter panel, result list with count',
  position_count: 6,
  shadow_density: 0.17,
  elemental_balance: { Fire: 0, Water: 0, Air: 0, Earth: 0, Spirit: 0 },
  scaffold_confidence: 'high',
};

const intention = 'Build a user profile management API';

describe('scaffold materializer', () => {
  it('is deterministic — identical inputs produce identical outputs', () => {
    const result1 = materializeScaffold(facts, intention);
    const result2 = materializeScaffold(facts, intention);
    expect(result1.files).toEqual(result2.files);
    expect(result1.nextSteps).toEqual(result2.nextSteps);
  });

  it('generates exactly 9 files', () => {
    const result = materializeScaffold(facts, intention);
    expect(result.files).toHaveLength(9);
  });

  it('generates the expected file paths', () => {
    const result = materializeScaffold(facts, intention);
    const paths = result.files.map((f) => f.path);
    expect(paths).toEqual([
      '.ai/manifest.adf',
      '.ai/core.adf',
      '.ai/state.adf',
      'package.json',
      'tsconfig.json',
      'wrangler.toml',
      'src/index.ts',
      'test/index.test.ts',
      'README.md',
    ]);
  });

  it('derives the project name and embeds it in package.json', () => {
    const result = materializeScaffold(facts, intention);
    const pkgFile = result.files.find((f) => f.path === 'package.json')!;
    const pkg = JSON.parse(pkgFile.content);
    // "Build a user profile management API" → strips "build", slugifies first 3 words
    expect(pkg.name).toBe('a-user-profile');
  });

  it('detects Workers runtime and configures wrangler.toml + devDependencies', () => {
    const result = materializeScaffold(facts, intention);

    const wranglerFile = result.files.find((f) => f.path === 'wrangler.toml')!;
    expect(wranglerFile.content).toContain('main = "src/index.ts"');

    const pkgFile = result.files.find((f) => f.path === 'package.json')!;
    const pkg = JSON.parse(pkgFile.content);
    expect(pkg.devDependencies).toHaveProperty('wrangler');
  });

  it('handles empty facts without throwing', () => {
    const result = materializeScaffold({}, '');
    expect(Array.isArray(result.files)).toBe(true);
  });
});
