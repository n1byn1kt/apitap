import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startSocketServer, stopSocketServer, createRelayHandler } from '../../src/native-host.js';
import { browse } from '../../src/orchestration/browse.js';
import { requestBridgeCapture } from '../../src/bridge/client.js';

/**
 * End-to-end integration test for the agent-browser bridge.
 *
 * Simulates the full flow:
 *   CLI browse() → bridge client → Unix socket → native host relay →
 *   mock extension handler → skill file returned → replay → data
 *
 * No Chrome extension or browser needed — the "extension" is mocked
 * as a handler function passed to createRelayHandler.
 */
describe('agent-browser bridge e2e', () => {
  let tmpDir: string;
  let skillsDir: string;
  let socketPath: string;
  let httpServer: Server;
  let baseUrl: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apitap-bridge-e2e-'));
    skillsDir = path.join(tmpDir, 'skills');
    socketPath = path.join(tmpDir, 'bridge.sock');
    await fs.mkdir(skillsDir, { recursive: true });

    // Start a real HTTP server to serve API data
    httpServer = createServer((req, res) => {
      if (req.url === '/api/posts') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ posts: [{ id: 1, title: 'Hello' }, { id: 2, title: 'World' }] }));
      } else if (req.url === '/api/users') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ id: 1, name: 'Alice' }]));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>(r => httpServer.listen(0, r));
    baseUrl = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await stopSocketServer();
    await new Promise<void>(r => httpServer.close(() => r()));
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('full round trip: CLI → socket → relay → extension → skill → replay → data', async () => {
    // Mock extension handler: simulates what the Chrome extension would do
    const mockExtension = async (msg: any) => {
      if (msg.action === 'capture_request') {
        return {
          success: true,
          skillFiles: [{
            version: '1.2',
            domain: msg.domain,
            capturedAt: new Date().toISOString(),
            baseUrl,
            endpoints: [{
              id: 'get-api-posts',
              method: 'GET',
              path: '/api/posts',
              queryParams: {},
              headers: {},
              responseShape: { type: 'object', fields: ['posts'] },
              examples: { request: { url: `${baseUrl}/api/posts`, headers: {} }, responsePreview: null },
              replayability: { tier: 'green', verified: true, signals: [] },
            }],
            metadata: { captureCount: 1, filteredCount: 0, toolVersion: '1.0.0' },
            provenance: 'self',
          }],
        };
      }
      return { success: false, error: 'unknown action' };
    };

    // Start native host relay with mock extension
    const handler = createRelayHandler(mockExtension, skillsDir);
    await startSocketServer(socketPath, handler);

    // CLI bridge client sends capture request
    const bridgeResult = await requestBridgeCapture('e2e-test.example.com', socketPath);
    assert.equal(bridgeResult.success, true);
    assert.equal(bridgeResult.skillFiles?.length, 1);
    assert.equal(bridgeResult.skillFiles?.[0].domain, 'e2e-test.example.com');
  });

  it('browse() escalates through bridge and returns live data', async () => {
    // Mock extension returns a skill file pointing to our real HTTP server
    const mockExtension = async (msg: any) => {
      if (msg.action === 'capture_request') {
        return {
          success: true,
          skillFiles: [{
            version: '1.2',
            domain: msg.domain,
            capturedAt: new Date().toISOString(),
            baseUrl,
            endpoints: [{
              id: 'get-api-posts',
              method: 'GET',
              path: '/api/posts',
              queryParams: {},
              headers: {},
              responseShape: { type: 'object', fields: ['posts'] },
              examples: { request: { url: `${baseUrl}/api/posts`, headers: {} }, responsePreview: null },
              replayability: { tier: 'green', verified: true, signals: [] },
            }],
            metadata: { captureCount: 1, filteredCount: 0, toolVersion: '1.0.0' },
            provenance: 'self',
          }],
        };
      }
      return { success: false, error: 'unknown action' };
    };

    const handler = createRelayHandler(mockExtension, skillsDir);
    await startSocketServer(socketPath, handler);

    // browse() should: miss cache → miss disk → skip discovery → try bridge → succeed
    const result = await browse('http://e2e-bridge.example.com/api/posts', {
      skillsDir,
      skipDiscovery: true,
      _skipSsrfCheck: true,
      _bridgeSocketPath: socketPath,
    });

    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.skillSource, 'bridge');
      assert.equal(result.endpointId, 'get-api-posts');
      assert.ok(result.data);
      // Verify actual API data came through
      const data = result.data as any;
      assert.ok(data.posts);
      assert.equal(data.posts.length, 2);
      assert.equal(data.posts[0].title, 'Hello');
    }
  });

  it('bridge handles local actions (ping) without extension relay', async () => {
    const mockExtension = async () => ({ success: true });
    const handler = createRelayHandler(mockExtension, skillsDir);
    await startSocketServer(socketPath, handler);

    // Send a ping directly via socket — should be handled locally
    const response = await new Promise<any>((resolve, reject) => {
      const client = net.createConnection(socketPath, () => {
        client.write(JSON.stringify({ action: 'ping' }) + '\n');
      });
      let data = '';
      client.on('data', (chunk) => { data += chunk; });
      client.on('end', () => resolve(JSON.parse(data)));
      client.on('error', reject);
    });

    assert.equal(response.success, true);
    assert.equal(response.action, 'pong');
    assert.ok(response.version);
  });

  it('bridge handles save_skill locally and persists to disk', async () => {
    const mockExtension = async () => ({ success: true });
    const handler = createRelayHandler(mockExtension, skillsDir);
    await startSocketServer(socketPath, handler);

    const skillJson = JSON.stringify({
      version: '1.2',
      domain: 'saved.example.com',
      endpoints: [{ id: 'get-data', method: 'GET', path: '/data' }],
    });

    const response = await new Promise<any>((resolve, reject) => {
      const client = net.createConnection(socketPath, () => {
        client.write(JSON.stringify({
          action: 'save_skill',
          domain: 'saved.example.com',
          skillJson,
        }) + '\n');
      });
      let data = '';
      client.on('data', (chunk) => { data += chunk; });
      client.on('end', () => resolve(JSON.parse(data)));
      client.on('error', reject);
    });

    assert.equal(response.success, true);
    // Verify file was written to disk
    const saved = await fs.readFile(path.join(skillsDir, 'saved.example.com.json'), 'utf-8');
    const parsed = JSON.parse(saved);
    assert.equal(parsed.domain, 'saved.example.com');
  });

  it('browse falls back gracefully when bridge returns user_denied', async () => {
    const mockExtension = async () => ({
      success: false,
      error: 'user_denied',
    });

    const handler = createRelayHandler(mockExtension, skillsDir);
    await startSocketServer(socketPath, handler);

    const result = await browse('http://denied.example.com', {
      skillsDir,
      skipDiscovery: true,
      _skipSsrfCheck: true,
      _bridgeSocketPath: socketPath,
    });

    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.reason, 'user_denied');
      assert.ok(result.suggestion.includes('auth'));
    }
  });
});
