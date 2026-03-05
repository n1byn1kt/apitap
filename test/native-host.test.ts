import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { handleNativeMessage, startSocketServer, stopSocketServer, createRelayHandler, type NativeRequest, type NativeResponse } from '../src/native-host.js';

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

// Helper for socket tests
function sendSocketMessage(socketPath: string, message: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath, () => {
      client.write(JSON.stringify(message) + '\n');
    });
    let data = '';
    client.on('data', (chunk) => { data += chunk; });
    client.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch { reject(new Error('Invalid response')); }
    });
    client.on('error', reject);
  });
}

describe('unix socket relay', () => {
  let tmpDir: string;
  let socketPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apitap-socket-test-'));
    socketPath = path.join(tmpDir, 'bridge.sock');
  });

  afterEach(async () => {
    await stopSocketServer();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('accepts CLI connections and relays messages', async () => {
    const mockHandler = async (msg: any) => {
      if (msg.action === 'ping') return { success: true, action: 'pong' };
      return { success: false, error: 'unknown' };
    };

    await startSocketServer(socketPath, mockHandler);

    const response = await sendSocketMessage(socketPath, { action: 'ping' });
    assert.equal(response.success, true);
    assert.equal(response.action, 'pong');
  });

  it('handles concurrent CLI connections', async () => {
    const mockHandler = async (msg: any) => {
      await new Promise(r => setTimeout(r, 50));
      return { success: true, domain: msg.domain };
    };

    await startSocketServer(socketPath, mockHandler);

    const [r1, r2] = await Promise.all([
      sendSocketMessage(socketPath, { action: 'capture_request', domain: 'a.com' }),
      sendSocketMessage(socketPath, { action: 'capture_request', domain: 'b.com' }),
    ]);

    assert.equal(r1.domain, 'a.com');
    assert.equal(r2.domain, 'b.com');
  });

  it('cleans up stale socket on startup', async () => {
    await fs.writeFile(socketPath, 'stale');

    const mockHandler = async () => ({ success: true });
    await startSocketServer(socketPath, mockHandler);

    const response = await sendSocketMessage(socketPath, { action: 'ping' });
    assert.equal(response.success, true);
  });

  it('returns error for invalid JSON', async () => {
    const mockHandler = async () => ({ success: true });
    await startSocketServer(socketPath, mockHandler);

    const response = await new Promise<any>((resolve) => {
      const client = net.createConnection(socketPath, () => {
        const msg = Buffer.from('not-json\n');
        client.write(msg);
      });
      let data = '';
      client.on('data', (chunk) => { data += chunk; });
      client.on('end', () => { resolve(JSON.parse(data)); });
    });

    assert.equal(response.success, false);
    assert.ok(response.error?.includes('Invalid'));
  });
});

describe('relay handler', () => {
  it('routes save_skill to local handler', async () => {
    let relayedToExtension = false;
    const sendToExtension = async (msg: any) => {
      relayedToExtension = true;
      return { success: true };
    };

    const tmpDir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'apitap-relay-test-'));
    const handler = createRelayHandler(sendToExtension, tmpDir2);

    const result = await handler({
      action: 'save_skill',
      domain: 'test.com',
      skillJson: JSON.stringify({ domain: 'test.com', endpoints: [] }),
    });

    assert.equal(result.success, true);
    assert.equal(relayedToExtension, false);
    await fs.rm(tmpDir2, { recursive: true, force: true });
  });

  it('routes capture_request to extension', async () => {
    let relayedMessage: any = null;
    const sendToExtension = async (msg: any) => {
      relayedMessage = msg;
      return { success: true, skillFiles: [{ domain: 'x.com', endpoints: [] }] };
    };

    const handler = createRelayHandler(sendToExtension);
    const result = await handler({ action: 'capture_request', domain: 'x.com' });

    assert.equal(result.success, true);
    assert.deepEqual(relayedMessage, { action: 'capture_request', domain: 'x.com' });
  });

  it('returns error when extension relay fails', async () => {
    const sendToExtension = async () => {
      throw new Error('extension disconnected');
    };

    const handler = createRelayHandler(sendToExtension);
    const result = await handler({ action: 'capture_request', domain: 'x.com' });

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('extension disconnected'));
  });
});
