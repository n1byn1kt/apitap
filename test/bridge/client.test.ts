import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { bridgeAvailable, requestBridgeCapture } from '../../src/bridge/client.js';

describe('bridge client', () => {
  let tmpDir: string;
  let socketPath: string;
  let server: net.Server;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apitap-client-test-'));
    socketPath = path.join(tmpDir, 'bridge.sock');
  });

  afterEach(async () => {
    server?.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function startMockServer(handler: (msg: any) => any): Promise<void> {
    return new Promise((resolve) => {
      server = net.createServer((conn) => {
        let buf = '';
        conn.on('data', (chunk) => {
          buf += chunk.toString();
          const idx = buf.indexOf('\n');
          if (idx === -1) return;
          const msg = JSON.parse(buf.slice(0, idx));
          const response = handler(msg);
          conn.end(JSON.stringify(response) + '\n');
        });
      });
      server.listen(socketPath, resolve);
    });
  }

  it('returns false when socket does not exist', async () => {
    assert.equal(await bridgeAvailable(socketPath), false);
  });

  it('returns true when socket exists and is connectable', async () => {
    await startMockServer(() => ({ success: true }));
    assert.equal(await bridgeAvailable(socketPath), true);
  });

  it('sends capture_request and returns skill files', async () => {
    await startMockServer((msg) => ({
      success: true,
      skillFiles: [{ domain: msg.domain, endpoints: [] }],
    }));

    const result = await requestBridgeCapture('discord.com', socketPath);
    assert.equal(result.success, true);
    assert.equal(result.skillFiles?.length, 1);
    assert.equal(result.skillFiles?.[0].domain, 'discord.com');
  });

  it('handles connection refused gracefully', async () => {
    // Socket file exists but nothing listening (stale)
    await fs.writeFile(socketPath, 'stale');

    const result = await requestBridgeCapture('discord.com', socketPath);
    assert.equal(result.success, false);
  });

  it('handles timeout', async () => {
    // Server that never responds
    await new Promise<void>((resolve) => {
      server = net.createServer(() => { /* no response */ });
      server.listen(socketPath, resolve);
    });

    const result = await requestBridgeCapture('discord.com', socketPath, { timeout: 500 });
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('timeout'));
  });
});
