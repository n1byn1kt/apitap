// src/read/decoders/wikipedia.ts
import type { Decoder, ReadResult } from '../types.js';
import { safeFetch } from '../../discovery/fetch.js';

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export const wikipediaDecoder: Decoder = {
  name: 'wikipedia',
  patterns: [
    /([a-z]{2,3})\.wikipedia\.org\/wiki\/([^#?]+)/,
  ],

  async decode(url: string, options: { skipSsrf?: boolean; [key: string]: any } = {}): Promise<ReadResult | null> {
    try {
      const match = url.match(/([a-z]{2,3})\.wikipedia\.org\/wiki\/([^#?]+)/);
      if (!match) return null;

      const lang = match[1];
      const title = match[2];

      const apiBase = options._apiBaseUrl || `https://${lang}.wikipedia.org`;
      const apiUrl = `${apiBase}/api/rest_v1/page/summary/${title}`;

      const result = await safeFetch(apiUrl, { skipSsrf: options.skipSsrf });
      if (!result || result.status !== 200) return null;

      let data: any;
      try {
        data = JSON.parse(result.body);
      } catch {
        return null;
      }

      if (!data) return null;

      const articleTitle = data.title || data.displaytitle || decodeURIComponent(title);
      const extract = data.extract || '';
      const description = data.description || null;

      const content = extract;

      const links: Array<{ text: string; href: string }> = [];
      if (data.content_urls?.desktop?.page) {
        links.push({ text: 'Full article', href: data.content_urls.desktop.page });
      }

      const images: Array<{ alt: string; src: string }> = [];
      if (data.thumbnail?.source) {
        images.push({ alt: articleTitle, src: data.thumbnail.source });
      }

      return {
        url,
        title: articleTitle,
        author: null,
        description,
        content,
        links,
        images,
        metadata: {
          type: 'article',
          publishedAt: data.timestamp || null,
          source: 'wikipedia-rest',
          canonical: data.content_urls?.desktop?.page || null,
          siteName: 'Wikipedia',
        },
        cost: { tokens: estimateTokens(content) },
      };
    } catch {
      return null;
    }
  },
};
