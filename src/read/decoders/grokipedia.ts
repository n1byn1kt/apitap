// src/read/decoders/grokipedia.ts
import type { Decoder, ReadResult } from '../types.js';
import { safeFetch } from '../../discovery/fetch.js';

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Grokipedia decoder — xAI's open knowledge base (6M+ articles)
 *
 * API endpoints (all public, no auth):
 *   /api/page?slug=X&includeContent=true  — Full article with citations
 *   /api/full-text-search?query=X&limit=N — Search with relevance scoring
 *   /api/stats                            — Site-wide stats
 *   /api/typeahead?query=X                — Autocomplete
 *   /api/list-pages?limit=N               — Browse articles
 *   /api/top-contributors?limit=N         — Top editors
 *   /api/list-edit-requests?limit=N       — Recent edits
 */

const GROKIPEDIA_API = 'https://grokipedia.com/api';

export const grokipediaDecoder: Decoder = {
  name: 'grokipedia',
  patterns: [
    /grokipedia\.com\/wiki\/([^#?]+)/,
    /grokipedia\.com\/article\/([^#?]+)/,
    /grokipedia\.com\/search\?/,
    /grokipedia\.com\/?$/,
    /grokipedia\.com\/?(?:\?|#|$)/,
  ],

  async decode(url: string, options: { skipSsrf?: boolean; maxBytes?: number; [key: string]: any } = {}): Promise<ReadResult | null> {
    try {
      const apiBase = options._apiBaseUrl || GROKIPEDIA_API;

      // Search URL: /search?q=query
      const searchMatch = url.match(/grokipedia\.com\/search\?.*q=([^&#]+)/);
      if (searchMatch) {
        return decodeSearch(apiBase, decodeURIComponent(searchMatch[1]), url, options);
      }

      // Article URL: /wiki/Slug or /article/Slug
      const articleMatch = url.match(/grokipedia\.com\/(?:wiki|article)\/([^#?]+)/);
      if (articleMatch) {
        return decodeArticle(apiBase, articleMatch[1], url, options);
      }

      // Homepage: return stats + trending/recent
      if (/grokipedia\.com\/?(?:\?|#|$)/.test(url)) {
        return decodeHomepage(apiBase, url, options);
      }

      return null;
    } catch {
      return null;
    }
  },
};

async function decodeArticle(
  apiBase: string,
  slug: string,
  url: string,
  options: { skipSsrf?: boolean; maxBytes?: number; [key: string]: any },
): Promise<ReadResult | null> {
  const apiUrl = `${apiBase}/page?slug=${encodeURIComponent(slug)}&includeContent=true`;
  // Grokipedia articles can be very large (743KB+ for Elon Musk) — raise body limit to 2MB
  const result = await safeFetch(apiUrl, { skipSsrf: options.skipSsrf, maxBodySize: 2 * 1024 * 1024 });
  if (!result || result.status !== 200) return null;

  let data: any;
  try {
    data = JSON.parse(result.body);
  } catch {
    return null;
  }

  const page = data?.page;
  if (!page) return null;

  const title = page.title || decodeURIComponent(slug).replace(/_/g, ' ');
  const content = page.content || page.description || '';
  const citations = page.citations || [];
  const images = page.images || [];
  const metadata = page.metadata || {};
  const stats = page.stats || {};

  // Truncate content if maxBytes specified
  const maxChars = options.maxBytes ? options.maxBytes : 20000;
  const truncatedContent = content.length > maxChars
    ? content.slice(0, maxChars) + `\n\n[Truncated — full article is ${content.length} chars. ${citations.length} citations available.]`
    : content;

  // Build citations section (top 10)
  const topCitations = citations.slice(0, 10);
  const citationBlock = topCitations.length > 0
    ? '\n\n## Sources\n' + topCitations.map((c: any, i: number) =>
        `${i + 1}. [${c.title || 'Source'}](${c.url})`
      ).join('\n')
    : '';

  // Build stats line
  const statsLine = stats.totalViews
    ? `\n\nViews: ${Number(stats.totalViews).toLocaleString()} | Quality: ${stats.qualityScore || 'N/A'} | Language: ${metadata.language || 'en'}`
    : '';

  const resultImages = images.slice(0, 5).map((img: any) => ({
    alt: img.caption || title,
    src: img.url || '',
  }));

  const resultLinks: Array<{ text: string; href: string }> = [
    { text: 'Full article', href: `https://grokipedia.com/wiki/${slug}` },
  ];

  // Add citation links
  topCitations.forEach((c: any) => {
    if (c.url) {
      resultLinks.push({ text: c.title || 'Source', href: c.url });
    }
  });

  return {
    url,
    title,
    author: metadata.lastEditor || null,
    description: page.description || null,
    content: truncatedContent + citationBlock + statsLine,
    links: resultLinks,
    images: resultImages,
    metadata: {
      type: 'article',
      publishedAt: metadata.lastModified ? new Date(metadata.lastModified * 1000).toISOString() : null,
      source: 'grokipedia-api',
      canonical: `https://grokipedia.com/wiki/${slug}`,
      siteName: 'Grokipedia',
    },
    cost: { tokens: estimateTokens(truncatedContent + citationBlock + statsLine) },
  };
}

async function decodeSearch(
  apiBase: string,
  query: string,
  url: string,
  options: { skipSsrf?: boolean; [key: string]: any },
): Promise<ReadResult | null> {
  const apiUrl = `${apiBase}/full-text-search?query=${encodeURIComponent(query)}&limit=10`;
  const result = await safeFetch(apiUrl, { skipSsrf: options.skipSsrf });
  if (!result || result.status !== 200) return null;

  let data: any;
  try {
    data = JSON.parse(result.body);
  } catch {
    return null;
  }

  const results = data?.results || [];
  if (results.length === 0) return null;

  const content = results.map((r: any, i: number) => {
    const views = r.viewCount ? ` (${Number(r.viewCount).toLocaleString()} views)` : '';
    const snippet = (r.snippet || '').replace(/<\/?em>/g, '**').replace(/\n/g, ' ').trim();
    return `${i + 1}. **[${r.title}](https://grokipedia.com/wiki/${r.slug})**${views}\n   ${snippet}`;
  }).join('\n\n');

  const links = results.map((r: any) => ({
    text: r.title || r.slug,
    href: `https://grokipedia.com/wiki/${r.slug}`,
  }));

  return {
    url,
    title: `Grokipedia search: "${query}"`,
    author: null,
    description: `${results.length} results for "${query}"`,
    content,
    links,
    images: [],
    metadata: {
      type: 'search-results',
      publishedAt: null,
      source: 'grokipedia-api',
      canonical: null,
      siteName: 'Grokipedia',
    },
    cost: { tokens: estimateTokens(content) },
  };
}

async function decodeHomepage(
  apiBase: string,
  url: string,
  options: { skipSsrf?: boolean; [key: string]: any },
): Promise<ReadResult | null> {
  // Fetch stats
  const statsResult = await safeFetch(`${apiBase}/stats`, { skipSsrf: options.skipSsrf });
  let statsData: any = {};
  if (statsResult?.status === 200) {
    try { statsData = JSON.parse(statsResult.body); } catch {}
  }

  // Fetch recent edits
  const editsResult = await safeFetch(`${apiBase}/list-edit-requests?limit=5`, { skipSsrf: options.skipSsrf });
  let editsData: any = {};
  if (editsResult?.status === 200) {
    try { editsData = JSON.parse(editsResult.body); } catch {}
  }

  const totalPages = Number(statsData.totalPages || 0).toLocaleString();
  const indexGB = (Number(statsData.indexSizeBytes || 0) / (1024 ** 3)).toFixed(1);

  let content = `# Grokipedia\n\nAn open source, comprehensive collection of all knowledge.\n\n`;
  content += `**${totalPages} articles** | **${indexGB} GB index**\n\n`;

  const edits = editsData.editRequests || [];
  if (edits.length > 0) {
    content += `## Recent Activity\n`;
    for (const edit of edits) {
      const article = edit.slug?.replace(/_/g, ' ') || 'Unknown';
      const editor = edit.userId || 'Anonymous';
      content += `- **${article}** — edited by ${editor} (${edit.type?.replace('EDIT_REQUEST_TYPE_', '').toLowerCase().replace(/_/g, ' ')})\n`;
    }
  }

  return {
    url,
    title: 'Grokipedia',
    author: null,
    description: `Open knowledge base with ${totalPages} articles`,
    content,
    links: [],
    images: [],
    metadata: {
      type: 'website',
      publishedAt: null,
      source: 'grokipedia-api',
      canonical: 'https://grokipedia.com',
      siteName: 'Grokipedia',
    },
    cost: { tokens: estimateTokens(content) },
  };
}
