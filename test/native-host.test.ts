import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { handleNativeMessage, type NativeRequest, type NativeResponse } from '../src/native-host.js';

describe('native messaging host', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apitap-native-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('saves a skill file to the skills directory', async () => {
    const skillJson = JSON.stringify({
      version: '1.0',
      domain: 'api.example.com',
      endpoints: [{ method: 'GET', path: '/users' }],
    });

    const request: NativeRequest = {
      action: 'save_skill',
      domain: 'api.example.com',
      skillJson,
    };

    const response = await handleNativeMessage(request, tmpDir);
    assert.equal(response.success, true);
    assert.ok(response.path?.endsWith('api.example.com.json'));

    const saved = JSON.parse(await fs.readFile(path.join(tmpDir, 'api.example.com.json'), 'utf-8'));
    assert.equal(saved.domain, 'api.example.com');
    assert.deepEqual(saved.endpoints, [{ method: 'GET', path: '/users' }]);
  });

  it('rejects domain with path traversal', async () => {
    const request: NativeRequest = {
      action: 'save_skill',
      domain: '../../../etc/passwd',
      skillJson: '{}',
    };

    const response = await handleNativeMessage(request, tmpDir);
    assert.equal(response.success, false);
    assert.ok(response.error?.includes('Invalid domain'));
  });

  it('rejects domain with slashes', async () => {
    const request: NativeRequest = {
      action: 'save_skill',
      domain: 'foo/bar',
      skillJson: '{}',
    };

    const response = await handleNativeMessage(request, tmpDir);
    assert.equal(response.success, false);
  });

  it('rejects empty domain', async () => {
    const request: NativeRequest = {
      action: 'save_skill',
      domain: '',
      skillJson: '{}',
    };

    const response = await handleNativeMessage(request, tmpDir);
    assert.equal(response.success, false);
  });

  it('handles ping action', async () => {
    const request: NativeRequest = { action: 'ping' };
    const response = await handleNativeMessage(request, tmpDir);
    assert.equal(response.success, true);
    assert.equal(response.action, 'pong');
    assert.ok(response.version);
    assert.ok(response.skillsDir);
  });

  it('rejects unknown action', async () => {
    const request = { action: 'unknown' } as any;
    const response = await handleNativeMessage(request, tmpDir);
    assert.equal(response.success, false);
  });

  it('validates skillJson is valid JSON', async () => {
    const request: NativeRequest = {
      action: 'save_skill',
      domain: 'example.com',
      skillJson: 'not-json{{{',
    };

    const response = await handleNativeMessage(request, tmpDir);
    assert.equal(response.success, false);
    assert.ok(response.error?.includes('Invalid JSON'));
  });

  it('saves multiple domains', async () => {
    const r1: NativeRequest = {
      action: 'save_skill',
      domain: 'a.com',
      skillJson: JSON.stringify({ domain: 'a.com', endpoints: [] }),
    };
    const r2: NativeRequest = {
      action: 'save_skill',
      domain: 'b.com',
      skillJson: JSON.stringify({ domain: 'b.com', endpoints: [] }),
    };

    await handleNativeMessage(r1, tmpDir);
    await handleNativeMessage(r2, tmpDir);

    const files = await fs.readdir(tmpDir);
    assert.ok(files.includes('a.com.json'));
    assert.ok(files.includes('b.com.json'));
  });
});
