// src/read/decoders/deepwiki.ts
import type { Decoder, ReadResult } from '../types.js';
import { assertSsrfBypassAllowed } from '../../skill/ssrf.js';
import { safeFetch } from '../../discovery/fetch.js';

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * DeepWiki decoder — extracts wiki content from deepwiki.com
 * 
 * DeepWiki (by Devin/Cognition) auto-generates documentation wikis from GitHub repos.
 * It's a Next.js app that serves content via React Server Components (RSC).
 * 
 * Trick: Send `RSC: 1` header → get full markdown content in the RSC payload
 * instead of the JS-heavy SPA shell. No auth required.
 * 
 * URL patterns:
 *   deepwiki.com/{org}/{repo}              → overview page
 *   deepwiki.com/{org}/{repo}/{page-slug}  → specific wiki page
 */

const DEEPWIKI_PATTERN = /^https?:\/\/(www\.)?deepwiki\.com\/([^/]+)\/([^/]+)(\/.*)?$/;

export const deepwikiDecoder: Decoder = {
  name: 'deepwiki',
  patterns: [
    /^https?:\/\/(www\.)?deepwiki\.com\/[^/]+\/[^/]+/,
  ],

  async decode(url: string, options: { skipSsrf?: boolean; [key: string]: any } = {}): Promise<ReadResult | null> {
    const match = url.match(DEEPWIKI_PATTERN);
    if (!match) return null;

    const org = match[2];
    const repo = match[3];
    const pagePath = match[4] || '';

    // Sanitize extracted values for header injection
    const sanitize = (s: string) => s.replace(/[\r\n]/g, '');

    // Construct the path for the RSC request
    const fullPath = sanitize(`/${org}/${repo}${pagePath}`);

    // Test-only base-URL override so hermetic tests can point the decoder
    // at a local server (host is otherwise pinned to deepwiki.com). Gated
    // to test contexts like every other SSRF-relevant escape hatch (#64).
    assertSsrfBypassAllowed(options._testBaseUrl);
    const fetchUrl = options._testBaseUrl
      ? url.replace(/^https?:\/\/(www\.)?deepwiki\.com/, options._testBaseUrl)
      : url;

    try {
      // safeFetch: SSRF validation with DNS resolution, manual single-hop
      // redirects with target re-validation, timeout, and body cap — the
      // same pipeline every other decoder path gets (issue #63).
      const response = await safeFetch(fetchUrl, {
        skipSsrf: options.skipSsrf,
        timeout: 10_000,
        maxBodySize: 2 * 1024 * 1024,
        headers: {
          'RSC': '1',
          'Next-Url': fullPath,
          'User-Agent': 'Mozilla/5.0 (compatible; ApiTap/1.0)',
        },
      });

      if (!response || response.status < 200 || response.status >= 300) {
        return null;
      }

      const rscPayload = response.body;

      // Extract markdown content from RSC text nodes
      // Format: {id}:T{hexLength},{content}
      const contentBlocks: string[] = [];
      const lines = rscPayload.split('\n');

      let currentBlock: string | null = null;
      let expectedLength = 0;
      let collectedBytes = 0;

      for (const line of lines) {
        // Start of a new text block: {id}:T{hexLength},{content...}
        const blockMatch = line.match(/^[0-9a-f]+:T([0-9a-f]+),(.*)$/);

        if (blockMatch) {
          // Save previous block if exists
          if (currentBlock !== null) {
            contentBlocks.push(currentBlock);
          }

          expectedLength = parseInt(blockMatch[1], 16);
          const content = blockMatch[2];
          currentBlock = content;
          collectedBytes = Buffer.byteLength(content, 'utf-8');
          continue;
        }

        // If we're inside a block, keep collecting lines
        if (currentBlock !== null) {
          // Check if this line starts a new RSC record (not a continuation)
          if (/^[0-9a-f]+:[^T]/.test(line) || /^[0-9a-f]+:T[0-9a-f]+,/.test(line)) {
            // End of current block
            contentBlocks.push(currentBlock);
            currentBlock = null;

            // If it's a new T block, process it
            const newBlock = line.match(/^[0-9a-f]+:T([0-9a-f]+),(.*)$/);
            if (newBlock) {
              expectedLength = parseInt(newBlock[1], 16);
              currentBlock = newBlock[2];
              collectedBytes = Buffer.byteLength(newBlock[2], 'utf-8');
            }
            continue;
          }

          currentBlock += '\n' + line;
          collectedBytes += Buffer.byteLength('\n' + line, 'utf-8');

          // If we've collected enough bytes, end the block
          if (collectedBytes >= expectedLength) {
            contentBlocks.push(currentBlock);
            currentBlock = null;
          }
        }
      }

      // Don't forget the last block
      if (currentBlock !== null) {
        contentBlocks.push(currentBlock);
      }

      if (contentBlocks.length === 0) {
        return null;
      }

      // Find the largest content block — that's the main page content
      // (smaller blocks might be TOC section titles)
      const mainContent = contentBlocks.reduce((a, b) =>
        a.length > b.length ? a : b
      );

      if (!mainContent || mainContent.length < 50) {
        return null;
      }

      // Clean up the markdown
      let content = mainContent;

      // Extract title from first heading
      const titleMatch = content.match(/^#\s+(.+)$/m);
      const title = titleMatch
        ? `${titleMatch[1]} — ${org}/${repo} | DeepWiki`
        : `${org}/${repo} | DeepWiki`;

      // Fix relative links to point back to correct locations
      content = content.replace(
        /\[([^\]]+)\]\((?!https?:\/\/)([^)]+)\)/g,
        (full, text, href) => {
          // Source file links (e.g., README.md, src/foo.ts)
          if (href.match(/\.(ts|js|md|json|tsx|jsx|py|rs|go|toml|yaml|yml|css|html)$/)) {
            return `[${text}](https://github.com/${org}/${repo}/blob/main/${href})`;
          }
          // Section links (#2, #3.1, etc.)
          if (href.startsWith('#')) {
            return `[${text}](https://deepwiki.com/${org}/${repo}/${href.slice(1)})`;
          }
          // Other relative links
          return `[${text}](https://deepwiki.com/${org}/${repo}/${href})`;
        }
      );

      const tokens = estimateTokens(content);

      return {
        url,
        title,
        author: null,
        description: `DeepWiki documentation for ${org}/${repo}`,
        content,
        links: [],
        images: [],
        metadata: {
          type: 'wiki',
          publishedAt: null,
          source: 'deepwiki-rsc',
          canonical: `https://deepwiki.com/${org}/${repo}${pagePath}`,
          siteName: 'DeepWiki',
        },
        cost: { tokens },
      };
    } catch {
      return null;
    }
  },
};
