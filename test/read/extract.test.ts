// test/read/extract.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseHead, extractContent } from '../../src/read/extract.js';
import type { HeadMeta, ExtractResult } from '../../src/read/extract.js';

// ---- parseHead tests ----

describe('parseHead', () => {
  it('extracts <title> tag', () => {
    const html = '<html><head><title>My Page Title</title></head><body></body></html>';
    const meta = parseHead(html);
    assert.equal(meta.title, 'My Page Title');
  });

  it('extracts og:title', () => {
    const html = '<html><head><meta property="og:title" content="OG Title Here"></head></html>';
    const meta = parseHead(html);
    assert.equal(meta.ogTitle, 'OG Title Here');
  });

  it('extracts og:description', () => {
    const html = '<html><head><meta property="og:description" content="A description of the page"></head></html>';
    const meta = parseHead(html);
    assert.equal(meta.ogDescription, 'A description of the page');
  });

  it('extracts og:image', () => {
    const html = '<html><head><meta property="og:image" content="https://example.com/image.png"></head></html>';
    const meta = parseHead(html);
    assert.equal(meta.ogImage, 'https://example.com/image.png');
  });

  it('extracts og:type', () => {
    const html = '<html><head><meta property="og:type" content="article"></head></html>';
    const meta = parseHead(html);
    assert.equal(meta.ogType, 'article');
  });

  it('extracts og:site_name', () => {
    const html = '<html><head><meta property="og:site_name" content="My Site"></head></html>';
    const meta = parseHead(html);
    assert.equal(meta.ogSiteName, 'My Site');
  });

  it('extracts canonical URL', () => {
    const html = '<html><head><link rel="canonical" href="https://example.com/page"></head></html>';
    const meta = parseHead(html);
    assert.equal(meta.canonical, 'https://example.com/page');
  });

  it('extracts author', () => {
    const html = '<html><head><meta name="author" content="Jane Doe"></head></html>';
    const meta = parseHead(html);
    assert.equal(meta.author, 'Jane Doe');
  });

  it('extracts article:published_time', () => {
    const html = '<html><head><meta property="article:published_time" content="2026-01-15T10:00:00Z"></head></html>';
    const meta = parseHead(html);
    assert.equal(meta.publishedTime, '2026-01-15T10:00:00Z');
  });

  it('returns null for missing tags', () => {
    const html = '<html><head></head><body></body></html>';
    const meta = parseHead(html);
    assert.equal(meta.title, null);
    assert.equal(meta.ogTitle, null);
    assert.equal(meta.ogDescription, null);
    assert.equal(meta.ogImage, null);
    assert.equal(meta.ogType, null);
    assert.equal(meta.ogSiteName, null);
    assert.equal(meta.canonical, null);
    assert.equal(meta.author, null);
    assert.equal(meta.publishedTime, null);
  });

  it('handles content before property attribute order', () => {
    const html = '<html><head><meta content="Reversed OG Title" property="og:title"></head></html>';
    const meta = parseHead(html);
    assert.equal(meta.ogTitle, 'Reversed OG Title');
  });
});

// ---- extractContent tests ----

describe('extractContent', () => {
  it('extracts content from <article>', () => {
    const html = `
      <html><body>
        <div>noise</div>
        <article><p>Article content here</p></article>
      </body></html>
    `;
    const result = extractContent(html);
    assert.ok(result.content.includes('Article content here'));
    assert.ok(!result.content.includes('noise'));
  });

  it('extracts content from <main>', () => {
    const html = `
      <html><body>
        <div>noise</div>
        <main><p>Main content here</p></main>
      </body></html>
    `;
    const result = extractContent(html);
    assert.ok(result.content.includes('Main content here'));
    assert.ok(!result.content.includes('noise'));
  });

  it('strips nav, header, footer, aside', () => {
    const html = `
      <html><body>
        <nav>Navigation links</nav>
        <header>Site header</header>
        <main><p>Real content</p></main>
        <footer>Copyright info</footer>
        <aside>Sidebar</aside>
      </body></html>
    `;
    const result = extractContent(html);
    assert.ok(result.content.includes('Real content'));
    assert.ok(!result.content.includes('Navigation links'));
    assert.ok(!result.content.includes('Site header'));
    assert.ok(!result.content.includes('Copyright info'));
    assert.ok(!result.content.includes('Sidebar'));
  });

  it('strips script and style tags', () => {
    const html = `
      <html><body>
        <script>var x = 1;</script>
        <style>.foo { color: red; }</style>
        <main><p>Visible content</p></main>
      </body></html>
    `;
    const result = extractContent(html);
    assert.ok(result.content.includes('Visible content'));
    assert.ok(!result.content.includes('var x'));
    assert.ok(!result.content.includes('color: red'));
  });

  it('converts headings to markdown', () => {
    const html = '<html><body><article><h1>Title</h1><h2>Subtitle</h2><h3>Section</h3></article></body></html>';
    const result = extractContent(html);
    assert.ok(result.content.includes('# Title'));
    assert.ok(result.content.includes('## Subtitle'));
    assert.ok(result.content.includes('### Section'));
  });

  it('converts links and collects them', () => {
    const html = '<html><body><article><a href="https://example.com">Example</a></article></body></html>';
    const result = extractContent(html);
    assert.ok(result.content.includes('[Example](https://example.com)'));
    assert.equal(result.links.length, 1);
    assert.equal(result.links[0].text, 'Example');
    assert.equal(result.links[0].href, 'https://example.com');
  });

  it('converts images and collects them', () => {
    const html = '<html><body><article><img src="https://example.com/photo.jpg" alt="A photo"></article></body></html>';
    const result = extractContent(html);
    assert.ok(result.content.includes('![A photo](https://example.com/photo.jpg)'));
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].alt, 'A photo');
    assert.equal(result.images[0].src, 'https://example.com/photo.jpg');
  });

  it('converts bold and italic', () => {
    const html = '<html><body><article><p><strong>Bold text</strong> and <em>italic text</em></p></article></body></html>';
    const result = extractContent(html);
    assert.ok(result.content.includes('**Bold text**'));
    assert.ok(result.content.includes('*italic text*'));
  });

  it('converts unordered lists', () => {
    const html = '<html><body><article><ul><li>Apple</li><li>Banana</li><li>Cherry</li></ul></article></body></html>';
    const result = extractContent(html);
    assert.ok(result.content.includes('- Apple'));
    assert.ok(result.content.includes('- Banana'));
    assert.ok(result.content.includes('- Cherry'));
  });

  it('converts ordered lists', () => {
    const html = '<html><body><article><ol><li>First</li><li>Second</li><li>Third</li></ol></article></body></html>';
    const result = extractContent(html);
    assert.ok(result.content.includes('1. First'));
    assert.ok(result.content.includes('2. Second'));
    assert.ok(result.content.includes('3. Third'));
  });

  it('converts blockquotes', () => {
    const html = '<html><body><article><blockquote>This is a quote</blockquote></article></body></html>';
    const result = extractContent(html);
    assert.ok(result.content.includes('> This is a quote'));
  });

  it('converts code blocks and inline code', () => {
    const html = `
      <html><body><article>
        <pre><code>const x = 42;</code></pre>
        <p>Use <code>console.log</code> to debug.</p>
      </article></body></html>
    `;
    const result = extractContent(html);
    assert.ok(result.content.includes('```\nconst x = 42;\n```'));
    assert.ok(result.content.includes('`console.log`'));
  });

  it('collapses excessive whitespace', () => {
    const html = `
      <html><body><article>
        <p>First paragraph</p>




        <p>Second paragraph</p>
      </article></body></html>
    `;
    const result = extractContent(html);
    // Should not have more than 2 consecutive newlines
    assert.ok(!result.content.includes('\n\n\n'));
  });

  it('falls back to body when no content area found', () => {
    const html = '<html><body><p>Body level content</p></body></html>';
    const result = extractContent(html);
    assert.ok(result.content.includes('Body level content'));
  });

  it('detects SPA shell', () => {
    const html = `
      <html><body>
        <div id="root"></div>
        <script src="bundle.js"></script>
      </body></html>
    `;
    const result = extractContent(html);
    assert.equal(result.isSpaShell, true);
  });

  it('does not flag non-SPA pages', () => {
    const html = `
      <html><body>
        <article>
          <p>${'Lorem ipsum dolor sit amet. '.repeat(20)}</p>
        </article>
      </body></html>
    `;
    const result = extractContent(html);
    assert.equal(result.isSpaShell, false);
  });

  it('converts tables to markdown', () => {
    const html = `
      <html><body><article>
        <table>
          <tr><th>Name</th><th>Age</th></tr>
          <tr><td>Alice</td><td>30</td></tr>
          <tr><td>Bob</td><td>25</td></tr>
        </table>
      </article></body></html>
    `;
    const result = extractContent(html);
    assert.ok(result.content.includes('| Name | Age |'));
    assert.ok(result.content.includes('| --- | --- |'));
    assert.ok(result.content.includes('| Alice | 30 |'));
    assert.ok(result.content.includes('| Bob | 25 |'));
  });
});
