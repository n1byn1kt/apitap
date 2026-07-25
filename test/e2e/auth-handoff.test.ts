// test/e2e/auth-handoff.test.ts
// Live browser login handoff → encrypted session storage → replay with the
// captured session. This is the apitap_auth_request path end to end; the
// existing handoff tests only cover the detection helpers on synthetic
// headers, so nothing exercised launch → sniff → store → inject before this.
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestAuth } from '../../src/auth/handoff.js';
import { replayEndpoint } from '../../src/replay/engine.js';
import { AuthManager } from '../../src/auth/manager.js';
import type { SkillFile } from '../../src/types.js';

const SESSION_VALUE = 'sess-e2e-abc123';

describe('E2E: browser login handoff → stored session → authenticated replay', () => {
  let server: Server;
  let port: number;
  let baseUrl: string;
  let testDir: string;
  let authManager: AuthManager;
  /** Cookie header the fixture saw on its last /api/me call — the proof replay injected it. */
  let lastApiCookie: string | undefined;

  before(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? '/';

      // The login page. A human would type credentials here; the page does it
      // on load so the flow runs unattended — what is under test is ApiTap's
      // side of the handoff, not form-filling.
      if (req.method === 'GET' && url === '/login') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html><body><h1>Fixture login</h1>
          <script>
            fetch('/session', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ user: 'testuser', pass: 'hunter2' }),
            }).then(() => fetch('/api/me'));
          </script>
          </body></html>
        `);
        return;
      }

      // Successful login: hand back a session cookie, exactly as a real
      // login endpoint would.
      if (req.method === 'POST' && url === '/session') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `session_id=${SESSION_VALUE}; Path=/; HttpOnly`,
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // The private endpoint replay will later call with the stored session.
      if (req.method === 'GET' && url === '/api/me') {
        lastApiCookie = req.headers.cookie;
        if (!req.headers.cookie?.includes(`session_id=${SESSION_VALUE}`)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'not logged in' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ user: 'testuser', private: true }));
        return;
      }

      res.writeHead(404);
      res.end();
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise<void>(r => server.close(() => r()));
  });

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'apitap-handoff-e2e-'));
    authManager = new AuthManager(testDir, 'test-machine-id-handoff');
    lastApiCookie = undefined;
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  function meSkill(): SkillFile {
    return {
      version: '1.2',
      domain: '127.0.0.1',
      capturedAt: new Date().toISOString(),
      baseUrl,
      endpoints: [{
        id: 'get-api-me',
        method: 'GET',
        path: '/api/me',
        queryParams: {},
        headers: {},
        responseShape: { type: 'object', fields: ['user'] },
        examples: {
          request: { url: `${baseUrl}/api/me`, headers: {} },
          responsePreview: null,
        },
        replayability: { tier: 'green', verified: true, signals: [] },
      }],
      metadata: { captureCount: 1, filteredCount: 0, toolVersion: '1.0.0' },
      provenance: 'self' as const,
    };
  }

  it('captures the session from a real browser login and replays with it', async () => {
    // A real handoff ends when the human closes the window; unattended, the
    // timeout is the exit. Either way the same capture-and-store code runs.
    const result = await requestAuth(authManager, {
      domain: '127.0.0.1',
      loginUrl: `${baseUrl}/login`,
      timeout: 6000,
      _headless: true,
    });

    assert.equal(result.success, true, `handoff failed: ${result.error}`);
    assert.ok(result.cookieCount > 0, 'handoff captured no cookies');
    assert.equal(result.authDetected, 'cookie');

    // The session is on disk, encrypted, and retrievable.
    const session = await authManager.retrieveSession('127.0.0.1');
    assert.ok(session, 'no session stored for the domain');
    assert.ok(
      session.cookies.some(c => c.name === 'session_id' && c.value === SESSION_VALUE),
      'stored session is missing the login cookie',
    );

    // The payoff: replay reaches the private endpoint using only what the
    // handoff stored — no cookie is passed here.
    const replayed = await replayEndpoint(meSkill(), 'get-api-me', {
      authManager,
      domain: '127.0.0.1',
      _skipSsrfCheck: true,
    });

    assert.equal(replayed.status, 200, `replay was not authenticated: ${JSON.stringify(replayed.data)}`);
    assert.deepEqual(replayed.data, { user: 'testuser', private: true });
    assert.match(lastApiCookie ?? '', new RegExp(`session_id=${SESSION_VALUE}`));
  });

  it('does not authenticate replay when no handoff has run', async () => {
    // Guards the test above against passing for the wrong reason: without a
    // stored session the same replay must come back 401.
    const replayed = await replayEndpoint(meSkill(), 'get-api-me', {
      authManager,
      domain: '127.0.0.1',
      _skipSsrfCheck: true,
    });

    assert.equal(replayed.status, 401);
  });

  it('leaves the session where the next handoff will warm-start from it', async () => {
    // The user-facing failure this whole test file exists for: doHandoff
    // opens by calling retrieveSessionWithFallback to restore cookies, so a
    // session lost at write time means the human logs in again. Assert the
    // exact lookup that warm start performs, not just the raw record.
    await requestAuth(authManager, {
      domain: '127.0.0.1',
      loginUrl: `${baseUrl}/login`,
      timeout: 6000,
      _headless: true,
    });

    const warmStart = await authManager.retrieveSessionWithFallback('127.0.0.1');
    assert.ok(warmStart, 'warm start would find no session — the human would have to log in again');
    assert.ok(
      warmStart.cookies.some(c => c.name === 'session_id' && c.value === SESSION_VALUE),
      'warm-start session is missing the login cookie',
    );

    const stored = await authManager.retrieve('127.0.0.1');
    assert.ok(stored, 'handoff stored no replayable auth');
    assert.equal(stored.type, 'cookie');
    assert.match(stored.value ?? '', new RegExp(SESSION_VALUE));
  });

  it('writes the captured credentials to disk encrypted', async () => {
    // Credentials never land in a skill file, and the store they do land in
    // is unreadable at rest.
    await requestAuth(authManager, {
      domain: '127.0.0.1',
      loginUrl: `${baseUrl}/login`,
      timeout: 6000,
      _headless: true,
    });

    const raw = await readFile(join(testDir, 'auth.enc'));
    assert.ok(raw.length > 0, 'no auth store was written');
    assert.ok(
      !raw.toString('binary').includes(SESSION_VALUE),
      'session value is readable in plaintext on disk',
    );
  });
});
