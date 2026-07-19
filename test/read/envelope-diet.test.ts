import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createServer, type Server } from 'node:http';
import { read } from '../../src/read/index.js';

function pageWithNoise(): string {
  const links = Array.from({ length: 300 }, (_, i) =>
    `<a href="/story/${i % 120}">Story ${i % 120}</a>`).join('\n');
  const images = Array.from({ length: 40 }, (_, i) =>
    `<img src="/img/${i % 10}.jpg?w=${100 + i}" alt="pic ${i % 10}">`).join('\n');
  return `<!doctype html><html><head><title>Noise</title></head><body><article><p>${'Real content. '.repeat(100)}</p>${links}${images}</article></body></html>`;
}

describe('read envelope diet', () => {
  let server: Server;
  let base: string;

  before(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(pageWithNoise());
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}`;
  });

  after(() => server.close());

  it('dedupes links by href and caps at 100 with linksOmitted', async () => {
    const result = await read(`${base}/page`, { skipSsrf: true });
    assert.ok(result);
    const hrefs = result.links.map((l) => l.href);
    assert.strictEqual(new Set(hrefs).size, hrefs.length, 'links must be unique by href');
    assert.ok(result.links.length <= 100);
    assert.ok((result.linksOmitted ?? 0) > 0);
  });

  it('omits images by default with imagesOmitted count', async () => {
    const result = await read(`${base}/page`, { skipSsrf: true });
    assert.ok(result);
    assert.deepStrictEqual(result.images, []);
    assert.ok((result.imagesOmitted ?? 0) > 0);
  });

  it('includeImages restores images deduped by URL-sans-query', async () => {
    const result = await read(`${base}/page`, { skipSsrf: true, includeImages: true });
    assert.ok(result);
    assert.ok(result.images.length > 0 && result.images.length <= 10, `got ${result.images.length}`);
  });

  it('computes cost.tokens over the whole envelope', async () => {
    const result = await read(`${base}/page`, { skipSsrf: true });
    assert.ok(result);
    const envelopeTokens = Math.ceil(JSON.stringify(result).length / 4);
    assert.ok(result.cost.tokens >= envelopeTokens * 0.8, `${result.cost.tokens} vs ${envelopeTokens}`);
  });

  it('maxBytes bounds the envelope by shrinking links, content first-class', async () => {
    const result = await read(`${base}/page`, { skipSsrf: true, maxBytes: 3000 });
    assert.ok(result);
    const bytes = Buffer.byteLength(JSON.stringify(result), 'utf-8');
    assert.ok(bytes <= 6000, `envelope ${bytes} bytes`);
    assert.ok(result.content.length > 0, 'content survives before links');
  });

  it('scan:false keeps the legacy envelope (no diet)', async () => {
    const result = await read(`${base}/page`, { skipSsrf: true, scan: false });
    assert.ok(result);
    assert.ok(result.links.length > 100, 'legacy path must not cap links');
    assert.ok(result.images.length > 0, 'legacy path must keep images');
    assert.strictEqual(result.linksOmitted, undefined);
    assert.strictEqual(result.imagesOmitted, undefined);
  });
});
