// src/read/decoders/youtube.ts
import type { Decoder, ReadResult } from '../types.js';
import { safeFetch } from '../../discovery/fetch.js';

const DEFAULT_OEMBED_BASE = 'https://noembed.com';

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export const youtubeDecoder: Decoder = {
  name: 'youtube',
  patterns: [
    /youtube\.com\/watch\?v=/,
    /youtu\.be\//,
  ],

  async decode(url: string, options: { skipSsrf?: boolean; [key: string]: any } = {}): Promise<ReadResult | null> {
    try {
      const base = options._oembedBaseUrl || DEFAULT_OEMBED_BASE;
      const oembedUrl = `${base}/embed?url=${encodeURIComponent(url)}`;

      const result = await safeFetch(oembedUrl, { skipSsrf: options.skipSsrf });
      if (!result || result.status !== 200) return null;

      let data: any;
      try {
        data = JSON.parse(result.body);
      } catch {
        return null;
      }

      if (!data || !data.title) return null;

      const title = data.title || null;
      const author = data.author_name || null;

      const contentParts: string[] = [];
      if (title) contentParts.push(`Title: ${title}`);
      if (author) contentParts.push(`Author: ${author}`);
      if (data.author_url) contentParts.push(`Channel: ${data.author_url}`);
      const content = contentParts.join('\n');

      const links: Array<{ text: string; href: string }> = [];
      if (data.author_url) {
        links.push({ text: author || 'Channel', href: data.author_url });
      }

      const images: Array<{ alt: string; src: string }> = [];
      if (data.thumbnail_url) {
        images.push({ alt: title || 'Thumbnail', src: data.thumbnail_url });
      }

      return {
        url,
        title,
        author,
        description: author ? `Video by ${author}` : 'YouTube video',
        content,
        links,
        images,
        metadata: {
          type: 'video',
          publishedAt: null,
          source: 'youtube-oembed',
          canonical: url,
          siteName: 'YouTube',
        },
        cost: { tokens: estimateTokens(content) },
      };
    } catch {
      return null;
    }
  },
};
