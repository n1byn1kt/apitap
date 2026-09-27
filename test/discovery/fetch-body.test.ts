// test/discovery/fetch-body.test.ts
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { safeFetch } from '../../src/discovery/fetch.js';

let server: Server | undefined;
let baseUrl = '';

function serve(body: Buffer | string, headers: Record<string, string> = {}): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((_req, res) => { res.writeHead(200, headers); res.end(body); });
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
      resolve();
    });
  });
}

describe('safeFetch body decoding', () => {
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  it('does not emit U+FFFD when the cap splits a multibyte character', async () => {
    await serve('aé', { 'Content-Type': 'text/plain; charset=utf-8' }); // 61 C3 A9
    const result = await safeFetch(baseUrl, { skipSsrf: true, maxBodySize: 2 });
    assert.equal(result?.body, 'a');
  });

  it('decodes stacked content-codings (gzip, then deflate)', async () => {
    await serve(deflateSync(gzipSync('stacked')), { 'Content-Encoding': 'gzip, deflate' });
    const result = await safeFetch(baseUrl, { skipSsrf: true });
    assert.equal(result?.body, 'stacked');
  });

  for (const [name, enc, data] of [
    ['gzip', 'gzip', gzipSync('hello gzip')],
    ['brotli', 'br', brotliCompressSync('hello br')],
    ['zlib deflate', 'deflate', deflateSync('hello deflate')],
  ] as const) {
    it(`decodes ${name}`, async () => {
      await serve(data, { 'Content-Encoding': enc });
      const result = await safeFetch(baseUrl, { skipSsrf: true });
      assert.match(result?.body ?? '', /^hello /);
    });
  }

  it('caps decompressed bytes (gzip bomb stays bounded)', async () => {
    await serve(gzipSync(Buffer.alloc(20 * 1024 * 1024, 0x61)), { 'Content-Encoding': 'gzip' });
    const result = await safeFetch(baseUrl, { skipSsrf: true, maxBodySize: 1000 });
    assert.equal(result?.body.length, 1000);
  });
});
