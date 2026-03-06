// test/skill/validate.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateSkillFile } from '../../src/skill/validate.js';

function validSkill() {
  return {
    version: '1.1',
    domain: 'example.com',
    capturedAt: '2026-01-01T00:00:00Z',
    baseUrl: 'https://example.com',
    endpoints: [{
      id: 'get-data',
      method: 'GET',
      path: '/api/data',
      queryParams: {},
      headers: {},
      responseShape: { type: 'object' },
      examples: { request: { url: 'https://example.com/api/data', headers: {} }, responsePreview: null },
    }],
    metadata: { captureCount: 1, filteredCount: 0, toolVersion: '1.0.0' },
    provenance: 'self',
  };
}

describe('validateSkillFile', () => {
  it('accepts a valid skill file', () => {
    const result = validateSkillFile(validSkill());
    assert.equal(result.domain, 'example.com');
  });

  it('rejects null input', () => {
    assert.throws(() => validateSkillFile(null), /must be an object/);
  });

  it('rejects non-object input', () => {
    assert.throws(() => validateSkillFile('string'), /must be an object/);
  });

  it('rejects missing domain', () => {
    const s = validSkill();
    delete (s as any).domain;
    assert.throws(() => validateSkillFile(s), /domain/i);
  });

  it('rejects empty domain', () => {
    const s = validSkill();
    s.domain = '';
    assert.throws(() => validateSkillFile(s), /domain/i);
  });

  it('rejects domain over 253 chars', () => {
    const s = validSkill();
    s.domain = 'a'.repeat(254);
    assert.throws(() => validateSkillFile(s), /domain/i);
  });

  it('rejects missing baseUrl', () => {
    const s = validSkill();
    delete (s as any).baseUrl;
    assert.throws(() => validateSkillFile(s), /baseUrl/i);
  });

  it('rejects non-HTTP baseUrl', () => {
    const s = validSkill();
    s.baseUrl = 'ftp://example.com';
    assert.throws(() => validateSkillFile(s), /baseUrl/i);
  });

  it('rejects invalid baseUrl', () => {
    const s = validSkill();
    s.baseUrl = 'not-a-url';
    assert.throws(() => validateSkillFile(s), /baseUrl/i);
  });

  it('rejects private IP baseUrl with checkSsrf', () => {
    const s = validSkill();
    s.baseUrl = 'http://192.168.1.1';
    assert.throws(() => validateSkillFile(s, { checkSsrf: true }), /baseUrl/i);
  });

  it('rejects localhost baseUrl with checkSsrf', () => {
    const s = validSkill();
    s.baseUrl = 'http://localhost:3000';
    assert.throws(() => validateSkillFile(s, { checkSsrf: true }), /baseUrl/i);
  });

  it('allows localhost baseUrl without checkSsrf when domain matches', () => {
    const s = validSkill();
    s.domain = 'localhost';
    s.baseUrl = 'http://localhost:3000';
    const result = validateSkillFile(s);
    assert.equal(result.baseUrl, 'http://localhost:3000');
  });

  it('rejects baseUrl hostname mismatch with domain', () => {
    const s = validSkill();
    s.domain = 'example.com';
    s.baseUrl = 'https://evil.com';
    assert.throws(() => validateSkillFile(s), /does not match domain/i);
  });

  it('allows subdomain baseUrl for domain', () => {
    const s = validSkill();
    s.domain = 'example.com';
    s.baseUrl = 'https://api.example.com';
    const result = validateSkillFile(s);
    assert.equal(result.baseUrl, 'https://api.example.com');
  });

  it('rejects missing endpoints', () => {
    const s = validSkill();
    delete (s as any).endpoints;
    assert.throws(() => validateSkillFile(s), /endpoints/i);
  });

  it('rejects endpoints not an array', () => {
    const s = validSkill();
    (s as any).endpoints = 'not-array';
    assert.throws(() => validateSkillFile(s), /endpoints/i);
  });

  it('rejects too many endpoints (>500)', () => {
    const s = validSkill();
    s.endpoints = Array.from({ length: 501 }, (_, i) => ({
      id: `ep-${i}`, method: 'GET', path: `/p/${i}`,
      queryParams: {}, headers: {},
      responseShape: { type: 'object' },
      examples: { request: { url: `https://example.com/p/${i}`, headers: {} }, responsePreview: null },
    }));
    assert.throws(() => validateSkillFile(s), /too many endpoints/i);
  });

  it('rejects endpoint missing id', () => {
    const s = validSkill();
    delete (s as any).endpoints[0].id;
    assert.throws(() => validateSkillFile(s), /endpoint.*id/i);
  });

  it('rejects endpoint missing method', () => {
    const s = validSkill();
    delete (s as any).endpoints[0].method;
    assert.throws(() => validateSkillFile(s), /endpoint.*method/i);
  });

  it('rejects endpoint missing path', () => {
    const s = validSkill();
    delete (s as any).endpoints[0].path;
    assert.throws(() => validateSkillFile(s), /endpoint.*path/i);
  });

  it('rejects invalid HTTP method', () => {
    const s = validSkill();
    s.endpoints[0].method = 'TRACE';
    assert.throws(() => validateSkillFile(s), /method/i);
  });

  it('rejects endpoint path not starting with /', () => {
    const s = validSkill();
    s.endpoints[0].path = 'no-slash';
    assert.throws(() => validateSkillFile(s), /path.*start with/i);
  });

  it('rejects endpoint id over 200 chars', () => {
    const s = validSkill();
    s.endpoints[0].id = 'x'.repeat(201);
    assert.throws(() => validateSkillFile(s), /endpoint.*id/i);
  });

  it('rejects endpoint path over 2000 chars', () => {
    const s = validSkill();
    s.endpoints[0].path = '/' + 'a'.repeat(2000);
    assert.throws(() => validateSkillFile(s), /path.*2000/i);
  });
});
