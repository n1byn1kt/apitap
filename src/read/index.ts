// src/read/index.ts
export { peek } from './peek.js';
export type { PeekOptions } from './peek.js';
export type { PeekResult, ReadResult, Decoder } from './types.js';

import type { ReadResult } from './types.js';
import { safeFetch } from '../discovery/fetch.js';
import { findDecoder } from './decoders/index.js';
import { parseHead, extractContent } from './extract.js';
import { scanRawHtml } from './scan.js';
import { appendFinding } from '../trapaware/audit.js';

export interface ReadOptions {
  skipSsrf?: boolean;
  maxBytes?: number;
  /** Enable trap-aware content scanning on fetched HTML. Default: true.
   *  When false, the scanner does not run and the ReadResult has no
   *  `findings` field (byte-identical to pre-v1.0 output). */
  scan?: boolean;
}

/**
 * Universal content decoder. Routes to site-specific decoders for known sites
 * (Reddit, YouTube, Wikipedia, HN), falls back to generic HTML extraction.
 * Returns null if content cannot be extracted.
 *
 * Trap-aware scanning: when `scan` is true (default), the generic HTML
 * pipeline runs the hidden-content scanner against raw HTML before
 * extraction. Site-specific decoders bypass the scanner because they
 * consume structured data (JSON APIs, not raw HTML) and do not carry the
 * same content-injection attack surface.
 */
export async function read(url: string, options: ReadOptions = {}): Promise<ReadResult | null> {
  const scanEnabled = options.scan !== false;

  // Try site-specific decoder first
  const decoder = findDecoder(url);
  if (decoder) {
    const result = await decoder.decode(url, { skipSsrf: options.skipSsrf });
    if (result) {
      if (options.maxBytes && result.content.length > options.maxBytes) {
        result.content = result.content.slice(0, options.maxBytes);
        result.cost.tokens = Math.ceil(result.content.length / 4);
      }
      // Decoders bypass scanning — they extract from structured sources.
      // Do NOT attach a findings field; preserve existing decoder envelope.
      return result;
    }
    // Decoder returned null — fall through to generic
  }

  // Generic pipeline: fetch HTML -> scan -> parse head -> extract body
  const fetchResult = await safeFetch(url, { skipSsrf: options.skipSsrf });
  if (!fetchResult || fetchResult.status !== 200) return null;

  const html = fetchResult.body;

  // Trap-aware scan runs on raw HTML, before extraction.
  let findings: ReturnType<typeof scanRawHtml> | undefined;
  if (scanEnabled) {
    findings = scanRawHtml(html);
    // Best-effort audit log write. Failures do not fail the read.
    for (const f of findings) {
      await appendFinding(f, url);
    }
  }

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
    ...(findings !== undefined ? { findings } : {}),
  };
}
