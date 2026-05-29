// test/security/provenance-integrity.test.ts
// Integrity: provenance must be authenticated by the signature, and the
// `imported` provenance value must not bypass signature verification.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  signSkillFile,
  signSkillFileAs,
  verifySignature,
  provenanceForSigning,
} from '../../src/skill/signing.js';
import { deriveKey } from '../../src/auth/crypto.js';
import { readSkillFile } from '../../src/skill/store.js';
import { importSkillFile } from '../../src/skill/importer.js';
import type { SkillFile, SkillEndpoint } from '../../src/types.js';

const key = deriveKey('test-machine-id');

function endpoint(id: string, prov?: SkillEndpoint['endpointProvenance']): SkillEndpoint {
  return {
    id,
    method: 'GET',
    path: `/api/${id}`,
    queryParams: {},
    headers: {},
    responseShape: { type: 'array', fields: ['id'] },
    examples: {
      request: { url: `https://example.com/api/${id}`, headers: {} },
      responsePreview: null,
    },
    ...(prov ? { endpointProvenance: prov } : {}),
  };
}

function makeSkill(endpoints = [endpoint('data')]): SkillFile {
  return {
    version: '1.1',
    domain: 'example.com',
    capturedAt: '2026-02-04T12:00:00.000Z',
    baseUrl: 'https://example.com',
    endpoints,
    metadata: { captureCount: 1, filteredCount: 0, toolVersion: '0.2.0' },
    provenance: 'unsigned',
  };
}

describe('provenance is authenticated by the signature', () => {
  it('verifySignature fails when provenance is tampered after signing', () => {
    const signed = signSkillFile(makeSkill(), key); // provenance: 'self'
    assert.equal(verifySignature(signed, key), true);

    const tampered = { ...signed, provenance: 'imported' as const };
    assert.equal(
      verifySignature(tampered, key),
      false,
      'flipping provenance to "imported" must invalidate the signature',
    );
  });
});

describe('imported provenance does not bypass verification', () => {
  it('a tampered file claiming provenance:"imported" is rejected on load', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'apitap-prov-'));
    try {
      // Start from a legitimately self-signed file, then inject an endpoint
      // and relabel it as imported (the classic verification-skip bypass).
      // baseUrl stays on-domain so validateSkillFile's domain-lock isn't what
      // rejects it — the signature check must.
      const signed = signSkillFile(makeSkill(), key);
      const tampered: SkillFile = {
        ...signed,
        endpoints: [...signed.endpoints, endpoint('injected')],
        provenance: 'imported',
      };
      await writeFile(join(dir, 'example.com.json'), JSON.stringify(tampered), 'utf-8');

      await assert.rejects(
        () => readSkillFile('example.com', dir, { signingKey: key }),
        /verification failed|tamper/i,
        'imported provenance must not skip signature verification',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('importSkillFile signs imported files locally', () => {
  it('writes an imported-signed file that verifies and loads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'apitap-imp-'));
    try {
      // A foreign skill file with no signature, arriving from outside.
      const foreign = makeSkill();
      const srcPath = join(dir, 'foreign.json');
      await writeFile(srcPath, JSON.stringify(foreign), 'utf-8');

      const result = await importSkillFile(srcPath, dir, key);
      assert.equal(result.success, true, result.success ? '' : result.reason);

      // The stored file must carry a local signature, not be left unsigned.
      const stored = await readSkillFile('example.com', dir, { signingKey: key });
      assert.ok(stored, 'imported file should load');
      assert.equal(stored!.provenance, 'imported-signed');
      assert.equal(verifySignature(stored!, key), true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('provenanceForSigning enforces minimum trust', () => {
  it('returns self only when every endpoint is captured', () => {
    const captured = makeSkill([endpoint('a'), endpoint('b', 'captured')]);
    assert.equal(provenanceForSigning(captured), 'self');
  });

  it('returns imported-signed when any endpoint comes from an import', () => {
    const mixed = makeSkill([endpoint('a', 'captured'), endpoint('b', 'openapi-import')]);
    assert.equal(
      provenanceForSigning(mixed),
      'imported-signed',
      'a single imported endpoint must downgrade the whole file from self',
    );
  });
});
