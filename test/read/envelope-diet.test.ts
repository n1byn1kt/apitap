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
    // Firebase-style routes for the HN decoder fixture: one item with ~50 KB
    // of body text so the decoder path must engage the envelope diet.
    const bigText = 'Decoder content that must be capped. '.repeat(1400); // ~52 KB
    const firebaseRoutes: Record<string, unknown> = {
      '/v0/item/12345.json': {
        id: 12345,
        title: 'Big decoder story',
        by: 'testuser',
        score: 150,
        text: bigText,
        type: 'story',
        time: 1700000000,
        kids: [],
        descendants: 0,
      },
    };

    server = createServer((req, res) => {
      const firebase = firebaseRoutes[req.url ?? ''];
      if (firebase) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(firebase));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      if (req.url === '/big') {
        // Large content, zero links: link shrinking cannot rescue the envelope.
        res.end(`<!doctype html><html><head><title>Big</title></head><body><article><p>${'Long content. '.repeat(600)}</p></article></body></html>`);
        return;
      }
      res.end(pageWithNoise());
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}`;
  });

  after(() => server.close());

  // Fixture helpers — generic HTML read and HN-style decoder read.
  const readWithFixture = (opts: { maxBytes?: number } = {}) =>
    read(`${base}/page`, { skipSsrf: true, ...opts });
  const readDecoderFixture = (opts: { maxBytes?: number } = {}) =>
    read('https://news.ycombinator.com/item?id=12345', {
      skipSsrf: true,
      _apiBaseUrl: base,
      ...opts,
    });

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

  it('re-slices content byte-accurately after links are exhausted, with a signal (issue #62)', async () => {
    const result = await read(`${base}/big`, { skipSsrf: true, maxBytes: 2000 });
    assert.ok(result);
    const bytes = Buffer.byteLength(JSON.stringify(result), 'utf-8');
    assert.ok(bytes <= 2000, `envelope ${bytes} bytes exceeds maxBytes 2000`);
    assert.strictEqual(result.contentTruncated, true, 'content truncation must carry a signal');
    assert.ok(result.content.length > 0, 'some content must survive');
  });

  it('does not set contentTruncated when the envelope fits', async () => {
    const result = await read(`${base}/big`, { skipSsrf: true, maxBytes: 100_000 });
    assert.ok(result);
    assert.strictEqual(result.contentTruncated, undefined);
  });

  it('read envelope reports envelopeBytes matching its serialized size', async () => {
    const result = await readWithFixture({ maxBytes: 5000 });
    assert.ok(result);
    assert.equal(typeof result.envelopeBytes, 'number');
    const measured = Buffer.byteLength(JSON.stringify(result), 'utf-8');
    // envelopeBytes was measured with a fixed-width placeholder — allow ±16 bytes
    assert.ok(Math.abs(measured - result.envelopeBytes!) <= 16, `${measured} vs ${result.envelopeBytes}`);
    assert.ok(result.envelopeBytes! <= 5000 + 16);
  });

  it('DECODER results are envelope-capped too (grok P0-1 regression test)', async () => {
    const result = await readDecoderFixture({ maxBytes: 4000 });
    assert.ok(result);
    const measured = Buffer.byteLength(JSON.stringify(result), 'utf-8');
    assert.ok(measured <= 4000 + 16, `decoder envelope ${measured} > 4000`);
    assert.equal(result.contentTruncated, true);
    assert.equal(typeof result.envelopeBytes, 'number');
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
