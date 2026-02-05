// test/skill/ssrf.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateUrl, validateSkillFileUrls } from '../../src/skill/ssrf.js';
import type { SkillFile } from '../../src/types.js';

describe('SSRF validation', () => {
  describe('validateUrl', () => {
    it('allows public HTTPS URLs', () => {
      assert.equal(validateUrl('https://api.example.com/data').safe, true);
      assert.equal(validateUrl('https://polymarket.com').safe, true);
    });

    it('allows public HTTP URLs', () => {
      assert.equal(validateUrl('http://api.example.com').safe, true);
    });

    it('rejects localhost', () => {
      const r = validateUrl('http://localhost/admin');
      assert.equal(r.safe, false);
      assert.ok(r.reason!.includes('internal'));
    });

    it('rejects 127.0.0.1', () => {
      assert.equal(validateUrl('http://127.0.0.1:8080/api').safe, false);
    });

    it('rejects private IP ranges', () => {
      assert.equal(validateUrl('http://10.0.0.1/data').safe, false);
      assert.equal(validateUrl('http://172.16.0.1/data').safe, false);
      assert.equal(validateUrl('http://172.31.255.255/data').safe, false);
      assert.equal(validateUrl('http://192.168.1.1/data').safe, false);
    });

    it('rejects link-local addresses', () => {
      assert.equal(validateUrl('http://169.254.0.1/data').safe, false);
    });

    it('rejects IPv6 loopback', () => {
      assert.equal(validateUrl('http://[::1]/data').safe, false);
    });

    it('rejects .local and .internal domains', () => {
      assert.equal(validateUrl('http://myapp.local/api').safe, false);
      assert.equal(validateUrl('http://db.internal/query').safe, false);
    });

    it('rejects non-HTTP schemes', () => {
      assert.equal(validateUrl('file:///etc/passwd').safe, false);
      assert.equal(validateUrl('ftp://files.internal/data').safe, false);
      assert.equal(validateUrl('gopher://evil.com/attack').safe, false);
    });

    it('allows 172.x IPs outside private range', () => {
      assert.equal(validateUrl('http://172.32.0.1/data').safe, true);
      assert.equal(validateUrl('http://172.15.0.1/data').safe, true);
    });

    it('rejects invalid URLs', () => {
      assert.equal(validateUrl('not-a-url').safe, false);
    });
  });

  describe('validateSkillFileUrls', () => {
    function makeSkill(baseUrl: string, endpointUrls: string[] = []): SkillFile {
      return {
        version: '1.1',
        domain: 'example.com',
        capturedAt: '2026-02-04T12:00:00.000Z',
        baseUrl,
        endpoints: endpointUrls.map((url, i) => ({
          id: `ep-${i}`,
          method: 'GET',
          path: new URL(url).pathname,
          queryParams: {},
          headers: {},
          responseShape: { type: 'object' },
          examples: { request: { url, headers: {} }, responsePreview: null },
        })),
        metadata: { captureCount: 1, filteredCount: 0, toolVersion: '0.2.0' },
        provenance: 'unsigned',
      };
    }

    it('passes for safe skill file', () => {
      const result = validateSkillFileUrls(makeSkill('https://api.example.com', [
        'https://api.example.com/data',
      ]));
      assert.equal(result.safe, true);
    });

    it('fails for SSRF in baseUrl', () => {
      const result = validateSkillFileUrls(makeSkill('http://localhost:8080'));
      assert.equal(result.safe, false);
    });

    it('fails for SSRF in endpoint example URL', () => {
      const result = validateSkillFileUrls(makeSkill('https://safe.com', [
        'http://192.168.1.1/admin',
      ]));
      assert.equal(result.safe, false);
    });
  });
});
