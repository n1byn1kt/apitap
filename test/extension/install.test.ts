import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { generateHostManifest, getBrowserPaths, installNativeHost } from '../../src/extension/install.js';

describe('extension install', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apitap-install-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('generateHostManifest', () => {
    it('generates valid native messaging host manifest', () => {
      const manifest = generateHostManifest('/usr/local/bin/apitap-native-host', 'abc123');
      assert.equal(manifest.name, 'com.apitap.native');
      assert.equal(manifest.type, 'stdio');
      assert.equal(manifest.path, '/usr/local/bin/apitap-native-host');
      assert.deepEqual(manifest.allowed_origins, ['chrome-extension://abc123/']);
    });

    it('includes trailing slash in extension origin', () => {
      const manifest = generateHostManifest('/path', 'myid');
      assert.ok(manifest.allowed_origins[0].endsWith('/'));
    });
  });

  describe('getBrowserPaths', () => {
    it('returns paths for linux', () => {
      const paths = getBrowserPaths('linux');
      assert.ok(paths.length > 0);
      assert.ok(paths.some(p => p.includes('google-chrome')));
      assert.ok(paths.some(p => p.includes('chromium')));
      assert.ok(paths.some(p => p.includes('BraveSoftware')));
    });

    it('returns paths for darwin', () => {
      const paths = getBrowserPaths('darwin');
      assert.ok(paths.length > 0);
      assert.ok(paths.some(p => p.includes('Google/Chrome')));
    });
  });

  describe('installNativeHost', () => {
    it('writes manifest files to browser directories', async () => {
      const browserDirs = [
        path.join(tmpDir, 'chrome'),
        path.join(tmpDir, 'brave'),
      ];

      const result = await installNativeHost('/path/to/host', 'extid123', browserDirs);
      assert.ok(result.installed.length > 0);

      for (const dir of browserDirs) {
        const manifestPath = path.join(dir, 'com.apitap.native.json');
        const content = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
        assert.equal(content.name, 'com.apitap.native');
        assert.equal(content.path, '/path/to/host');
      }
    });

    it('creates directories if they do not exist', async () => {
      const deepDir = path.join(tmpDir, 'deep', 'nested', 'dir');
      const result = await installNativeHost('/path', 'id', [deepDir]);
      assert.ok(result.installed.length > 0);
    });
  });
});
