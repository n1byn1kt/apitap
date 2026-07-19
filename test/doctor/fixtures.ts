// test/doctor/fixtures.ts
import type { SkillEndpoint, SkillFile } from '../../src/types.js';

export function makeEndpoint(over: Partial<SkillEndpoint> = {}): SkillEndpoint {
  return {
    id: 'get-items',
    method: 'GET',
    path: '/api/items',
    queryParams: {},
    headers: {},
    responseShape: { type: 'object', fields: ['id', 'name'] },
    examples: {
      request: { url: 'https://example.com/api/items', headers: {} },
      responsePreview: { id: 1, name: 'x' },
    },
    ...over,
  };
}

export function makeSkill(over: Partial<SkillFile> = {}): SkillFile {
  return {
    version: '1.0',
    domain: 'example.com',
    capturedAt: '2026-07-01T00:00:00.000Z',
    baseUrl: 'https://example.com',
    endpoints: [makeEndpoint()],
    metadata: { captureCount: 1, filteredCount: 0, toolVersion: 'test' },
    provenance: 'self',
    ...over,
  };
}
