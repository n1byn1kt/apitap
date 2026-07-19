// test/doctor/engine.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { runDoctor } from '../../src/doctor/index.js';
import { quarantinePath, snapshotPath } from '../../src/doctor/snapshot.js';
import { signSkillFileAs, verifySignature } from '../../src/skill/signing.js';
import { readSkillFile } from '../../src/skill/store.js';
import { makeEndpoint, makeSkill } from './fixtures.js';

const NOW = new Date('2026-07-19T00:00:00.000Z');

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

describe('runDoctor', () => {
  let dir: string;
  const key = randomBytes(32);

  const beaconEp = () => makeEndpoint({
    id: 'post-capi', method: 'POST', path: '/capi/meta',
    responseShape: { type: 'object' }, responseBytes: 0,
    examples: { request: { url: 'https://mixed.com/capi/meta', headers: {} }, responsePreview: null },
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'doctor-engine-'));
    // junk domain (on capture blocklist) → quarantine
    await writeFile(join(dir, 'cdn.segment.com.json'),
      JSON.stringify(signSkillFileAs(makeSkill({ domain: 'cdn.segment.com', baseUrl: 'https://cdn.segment.com' }), key, 'self')));
    // good skill with one beacon endpoint → edit + re-sign
    await writeFile(join(dir, 'mixed.com.json'),
      JSON.stringify(signSkillFileAs(makeSkill({
        domain: 'mixed.com', baseUrl: 'https://mixed.com',
        endpoints: [makeEndpoint(), beaconEp()],
      }), key, 'self')));
    // TAMPERED skill with a beacon endpoint → edit must be REFUSED
    const tampered = signSkillFileAs(makeSkill({
      domain: 'tampered.com', baseUrl: 'https://tampered.com',
      endpoints: [makeEndpoint(), beaconEp()],
    }), key, 'self');
    (tampered as any).capturedAt = '2026-07-02T00:00:00.000Z'; // break the HMAC
    await writeFile(join(dir, 'tampered.com.json'), JSON.stringify(tampered));
    // clean skill → untouched (verified endpoint so unverified-tier stays quiet)
    await writeFile(join(dir, 'clean.com.json'),
      JSON.stringify(signSkillFileAs(makeSkill({
        domain: 'clean.com', baseUrl: 'https://clean.com',
        endpoints: [makeEndpoint({ replayability: { tier: 'green', verified: true, signals: [] } })],
      }), key, 'self')));
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('scan-only reports findings and mutates nothing', async () => {
    const before = await readFile(join(dir, 'mixed.com.json'), 'utf-8');
    const report = await runDoctor({ skillsDir: dir, signingKey: key, now: NOW });
    assert.equal(report.scanned, 4);
    assert.equal(report.fixes.length, 0);
    assert.ok(report.findings.some(f => f.checkId === 'junk-domain' && f.domain === 'cdn.segment.com'));
    assert.ok(report.findings.some(f => f.checkId === 'beacon-endpoints' && f.domain === 'mixed.com'));
    assert.ok(report.findings.some(f => f.checkId === 'invalid-signature' && f.domain === 'tampered.com'));
    assert.equal(await readFile(join(dir, 'mixed.com.json'), 'utf-8'), before);
  });

  it('--fix quarantines junk, edits+re-signs mixed, refuses edits on tampered', async () => {
    const report = await runDoctor({ skillsDir: dir, signingKey: key, fix: true, now: NOW });

    // junk quarantined
    assert.equal(await exists(join(dir, 'cdn.segment.com.json')), false);
    assert.equal(await exists(quarantinePath(dir, 'cdn.segment.com')), true);
    assert.deepEqual(report.quarantined, ['cdn.segment.com']);

    // mixed edited: beacon stripped, snapshot exists, re-signed with valid provenance-aware signature
    assert.equal(await exists(snapshotPath(dir, 'mixed.com')), true);
    const mixed = JSON.parse(await readFile(join(dir, 'mixed.com.json'), 'utf-8'));
    assert.equal(mixed.endpoints.length, 1);
    assert.equal(mixed.provenance, 'self');
    assert.equal(verifySignature(mixed, key), true);
    // and store.ts hard-verify still loads it
    await readSkillFile('mixed.com', dir, { verifySignature: true, signingKey: key });

    // tampered: NOT edited, NOT re-signed
    const tampered = JSON.parse(await readFile(join(dir, 'tampered.com.json'), 'utf-8'));
    assert.equal(tampered.endpoints.length, 2);
    assert.equal(verifySignature(tampered, key), false);

    // clean untouched, no snapshot
    assert.equal(await exists(snapshotPath(dir, 'clean.com')), false);

    // remaining excludes fixed findings but keeps tampered's
    assert.ok(report.remaining.some(f => f.domain === 'tampered.com'));
    assert.ok(!report.remaining.some(f => f.domain === 'cdn.segment.com' && f.checkId === 'junk-domain'));
  });

  it('domain filter scopes the run', async () => {
    const report = await runDoctor({ skillsDir: dir, signingKey: key, domain: 'clean.com', now: NOW });
    assert.equal(report.scanned, 1);
    assert.equal(report.findings.length, 0);
  });
});
