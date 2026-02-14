import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { CaptureSession } from '../../src/capture/session.js';

// We test the navigate validation by creating a session and calling interact()
// with a mock page. Since start() launches a real browser, we test the logic
// by constructing the session and setting up internal state manually.

describe('F7: Session navigation URL validation', () => {
  // Helper: create a session with a mock page to avoid launching real browser
  function createSessionWithMockPage() {
    const session = new CaptureSession({ headless: true });

    const gotoUrls: string[] = [];
    const mockPage = {
      goto: async (url: string) => { gotoUrls.push(url); },
      url: () => 'https://example.com',
      title: async () => 'Test',
      evaluate: async () => [],
      content: async () => '<html></html>',
    };

    // Inject mock page via private field
    (session as any).page = mockPage;
    (session as any).closed = false;
    (session as any).expired = false;

    return { session, gotoUrls };
  }

  it('blocks file:///etc/passwd', async () => {
    const { session } = createSessionWithMockPage();
    const result = await session.interact({ action: 'navigate', url: 'file:///etc/passwd' });
    assert.equal(result.success, false);
    assert.ok(result.error!.includes('Blocked scheme'));
  });

  it('blocks javascript: URLs', async () => {
    const { session } = createSessionWithMockPage();
    const result = await session.interact({ action: 'navigate', url: 'javascript:alert(1)' });
    assert.equal(result.success, false);
  });

  it('blocks data: URLs', async () => {
    const { session } = createSessionWithMockPage();
    const result = await session.interact({ action: 'navigate', url: 'data:text/html,<h1>evil</h1>' });
    assert.equal(result.success, false);
    assert.ok(result.error!.includes('Blocked scheme'));
  });

  it('blocks ftp: URLs', async () => {
    const { session } = createSessionWithMockPage();
    const result = await session.interact({ action: 'navigate', url: 'ftp://example.com/file' });
    assert.equal(result.success, false);
    assert.ok(result.error!.includes('Blocked scheme'));
  });

  it('allows https: URLs', async () => {
    const { session, gotoUrls } = createSessionWithMockPage();
    const result = await session.interact({ action: 'navigate', url: 'https://example.com' });
    assert.equal(result.success, true);
    assert.deepEqual(gotoUrls, ['https://example.com']);
  });

  it('allows http: URLs', async () => {
    const { session, gotoUrls } = createSessionWithMockPage();
    const result = await session.interact({ action: 'navigate', url: 'http://example.com' });
    assert.equal(result.success, true);
    assert.deepEqual(gotoUrls, ['http://example.com']);
  });

  it('rejects invalid URL', async () => {
    const { session } = createSessionWithMockPage();
    const result = await session.interact({ action: 'navigate', url: 'not-a-url' });
    assert.equal(result.success, false);
    assert.ok(result.error!.includes('Invalid URL'));
  });
});
