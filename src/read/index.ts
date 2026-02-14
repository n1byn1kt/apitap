// src/read/index.ts
export { peek } from './peek.js';
export type { PeekOptions } from './peek.js';
export type { PeekResult, ReadResult, Decoder } from './types.js';

import type { ReadResult } from './types.js';
import { safeFetch } from '../discovery/fetch.js';
import { findDecoder } from './decoders/index.js';
import { parseHead, extractContent } from './extract.js';

export interface ReadOptions {
  skipSsrf?: boolean;
  maxBytes?: number;
}

/**
 * Universal content decoder. Routes to site-specific decoders for known sites
 * (Reddit, YouTube, Wikipedia, HN), falls back to generic HTML extraction.
 * Returns null if content cannot be extracted.
 */
export async function read(url: string, options: ReadOptions = {}): Promise<ReadResult | null> {
  // Try site-specific decoder first
  const decoder = findDecoder(url);
  if (decoder) {
    const result = await decoder.decode(url, { skipSsrf: options.skipSsrf });
    if (result) {
      if (options.maxBytes && result.content.length > options.maxBytes) {
        result.content = result.content.slice(0, options.maxBytes);
        result.cost.tokens = Math.ceil(result.content.length / 4);
      }
      return result;
    }
    // Decoder returned null -- fall through to generic
  }

  // Generic pipeline: fetch HTML -> parse head -> extract body
  const fetchResult = await safeFetch(url, { skipSsrf: options.skipSsrf });
  if (!fetchResult || fetchResult.status !== 200) return null;

  const html = fetchResult.body;
  const head = parseHead(html);
  const body = extractContent(html);

  // Determine source
  let source: string;
  if (body.isSpaShell) {
    source = 'spa-shell';
  } else if (body.content.trim().length === 0) {
    source = 'og-tags-only';
  } else {
    source = 'readability';
  }

  let content = body.content;
  if (options.maxBytes && content.length > options.maxBytes) {
    content = content.slice(0, options.maxBytes);
  }

  const title = head.ogTitle || head.title || null;

  return {
    url,
    title,
    author: head.author || null,
    description: head.ogDescription || null,
    content,
    links: body.links,
    images: body.images,
    metadata: {
      type: head.ogType || 'unknown',
      publishedAt: head.publishedTime || null,
      source,
      canonical: head.canonical || null,
      siteName: head.ogSiteName || null,
    },
    cost: { tokens: Math.ceil(content.length / 4) },
  };
}
