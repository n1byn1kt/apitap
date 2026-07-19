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
  /** Approximate envelope size bound: content is sliced to this many chars
   *  and links shrink to fit, but content + fixed metadata keep priority and
   *  can exceed it. */
  maxBytes?: number;
  /** Enable trap-aware content scanning on fetched HTML. Default: true.
   *  When false, the scanner does not run and the ReadResult has no
   *  `findings` field (byte-identical to pre-v1.0 output). */
  scan?: boolean;
  /** Include the images array in the envelope (deduped, capped). Default: false. */
  includeImages?: boolean;
}

const LINKS_CAP = 100;
const IMAGES_CAP = 50;

function dietLinks(links: Array<{ text: string; href: string }>): Array<{ text: string; href: string }> {
  const seen = new Set<string>();
  const out: Array<{ text: string; href: string }> = [];
  for (const link of links) {
    if (seen.has(link.href)) continue;
    seen.add(link.href);
    let text = link.text;
    const imgMd = /^!\[(.*?)\]\(.*\)$/.exec(text);
    if (imgMd) text = imgMd[1];
    if (text.trim() === '') continue; // no visible text after image-markdown unwrapping: drop
    out.push({ text, href: link.href });
  }
  return out;
}

function dietImages(images: Array<{ alt: string; src: string }>): Array<{ alt: string; src: string }> {
  const seen = new Set<string>();
  const out: Array<{ alt: string; src: string }> = [];
  for (const image of images) {
    const key = image.src.split('?')[0]; // kill responsive-crop duplicates
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(image);
    if (out.length >= IMAGES_CAP) break;
  }
  return out;
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
        result.contentTruncated = true;
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
  let contentTruncated = false;
  if (options.maxBytes && content.length > options.maxBytes) {
    content = content.slice(0, options.maxBytes);
    contentTruncated = true;
  }

  const title = head.ogTitle || head.title || null;

  const legacy = !scanEnabled;

  if (legacy) {
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

  const dietedLinks = dietLinks(body.links);
  const links = dietedLinks.slice(0, LINKS_CAP);
  const linksOmitted = body.links.length - links.length;

  const images = options.includeImages ? dietImages(body.images) : [];
  const imagesOmitted = body.images.length - images.length;

  const envelope: ReadResult = {
    url,
    title,
    author: head.author || null,
    description: head.ogDescription || null,
    content,
    links,
    ...(linksOmitted > 0 ? { linksOmitted } : {}),
    images,
    ...(imagesOmitted > 0 ? { imagesOmitted } : {}),
    ...(contentTruncated ? { contentTruncated: true } : {}),
    metadata: {
      type: head.ogType || 'unknown',
      publishedAt: head.publishedTime || null,
      source,
      canonical: head.canonical || null,
      siteName: head.ogSiteName || null,
    },
    cost: { tokens: 0 },
    ...(findings !== undefined ? { findings } : {}),
  };

  // maxBytes bounds the envelope: shrink links (halving) before touching content.
  if (options.maxBytes) {
    // cost.tokens is recomputed after shrinking; measure with its widest
    // possible value so the final number never grows the envelope past
    // the budget we just enforced.
    envelope.cost.tokens = Math.ceil(options.maxBytes / 4);
    while (
      Buffer.byteLength(JSON.stringify(envelope), 'utf-8') > options.maxBytes &&
      envelope.links.length > 0
    ) {
      const keep = Math.floor(envelope.links.length / 2);
      envelope.linksOmitted = (envelope.linksOmitted ?? 0) + (envelope.links.length - keep);
      envelope.links = envelope.links.slice(0, keep);
    }

    // Links exhausted but still over budget: binary-search the largest
    // content prefix whose full envelope fits (issue #62). Byte-accurate —
    // measured against the serialized envelope, not content length. Only
    // fixed metadata larger than maxBytes itself can still overshoot.
    if (
      Buffer.byteLength(JSON.stringify(envelope), 'utf-8') > options.maxBytes &&
      envelope.content.length > 0
    ) {
      const full = envelope.content;
      const suffix = '... [truncated]';
      // Set the signal BEFORE measuring so its own bytes are budgeted.
      envelope.contentTruncated = true;
      let lo = 0;
      let hi = full.length;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        envelope.content = full.slice(0, mid) + suffix;
        if (Buffer.byteLength(JSON.stringify(envelope), 'utf-8') <= options.maxBytes) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
      envelope.content = full.slice(0, lo) + suffix;
    }
  }

  envelope.cost = { tokens: Math.ceil(JSON.stringify(envelope).length / 4) };
  return envelope;
}
