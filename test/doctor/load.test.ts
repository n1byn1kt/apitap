// test/doctor/load.test.ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { loadSkillsForDoctor } from '../../src/doctor/index.js';
import { signatureFindings } from '../../src/doctor/checks/invalid-signature.js';
import { signSkillFileAs } from '../../src/skill/signing.js';
import { makeSkill } from './fixtures.js';

const NOW = new Date('2026-07-19T00:00:00.000Z');

describe('loadSkillsForDoctor', () => {
  let dir: string;
  const key = randomBytes(32);

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'doctor-load-'));
    // valid signed file
    const good = signSkillFileAs(makeSkill({ domain: 'good.com', baseUrl: 'https://good.com' }), key, 'self');
    await writeFile(join(dir, 'good.com.json'), JSON.stringify(good));
    // unsigned file
    await writeFile(join(dir, 'unsigned.com.json'),
      JSON.stringify(makeSkill({ domain: 'unsigned.com', baseUrl: 'https://unsigned.com' })));
    // tampered file: signed, then endpoint list mutated
    const tampered = signSkillFileAs(makeSkill({ domain: 'bad.com', baseUrl: 'https://bad.com' }), key, 'self');
    (tampered as any).endpoints = [];
    await writeFile(join(dir, 'bad.com.json'), JSON.stringify(tampered));
    // expired: valid signature but signedAt 200 days before NOW
    const old = signSkillFileAs(makeSkill({ domain: 'old.com', baseUrl: 'https://old.com' }), key, 'self');
    // re-sign date is now; fake age by rewriting signedAt AFTER signing breaks the HMAC,
    // so instead treat "expired" as: valid HMAC + old signedAt. We simulate by signing
    // with a monkeypatched clock is overkill — loader computes age from signedAt, and
    // signedAt is covered by the HMAC, so build it via signSkillFileAs and then
    // verify the loader's age logic with an injected `now` far in the future.
    await writeFile(join(dir, 'old.com.json'), JSON.stringify(old));
    // garbage file
    await writeFile(join(dir, 'broken.com.json'), '{ not json');
    // subdirectory must be ignored
    await mkdir(join(dir, '.quarantine'), { recursive: true });
    await writeFile(join(dir, '.quarantine', 'gone.com.json'), JSON.stringify(makeSkill()));
    // non-json ignored
    await writeFile(join(dir, 'index.bin'), 'x');
  });

  after(async () => { await rm(dir, { recursive: true, force: true }); });

  it('enumerates only top-level *.json and classifies signature status', async () => {
    const loaded = await loadSkillsForDoctor(dir, key, NOW);
    const byDomain = Object.fromEntries(loaded.map(l => [l.domain, l]));
    assert.equal(loaded.length, 5); // good, unsigned, bad, old, broken — not .quarantine, not index.bin
    assert.equal(byDomain['good.com'].signatureStatus, 'valid');
    assert.equal(byDomain['unsigned.com'].signatureStatus, 'unsigned');
    assert.equal(byDomain['bad.com'].signatureStatus, 'mismatch');
    assert.equal(byDomain['broken.com'].signatureStatus, 'invalid-file');
    assert.equal(byDomain['broken.com'].skill, null);
    assert.ok(byDomain['broken.com'].loadError);
  });

  it('marks valid-but-old signatures expired using injected now', async () => {
    const future = new Date('2027-06-01T00:00:00.000Z'); // >180d after signing
    const loaded = await loadSkillsForDoctor(dir, key, future);
    const old = loaded.find(l => l.domain === 'old.com')!;
    assert.equal(old.signatureStatus, 'expired');
  });
});

describe('signatureFindings', () => {
  it('maps non-valid statuses to warn findings and valid to none', () => {
    const base = { domain: 'x.com', filePath: '/x', skill: null };
    assert.equal(signatureFindings({ ...base, skill: makeSkill(), signatureStatus: 'valid' }).length, 0);
    for (const status of ['unsigned', 'mismatch', 'expired', 'invalid-file'] as const) {
      const f = signatureFindings({ ...base, signatureStatus: status, loadError: 'boom' });
      assert.equal(f.length, 1);
      assert.equal(f[0].checkId, 'invalid-signature');
      assert.equal(f[0].severity, 'warn');
      assert.equal(f[0].fixable, false);
    }
  });
});
