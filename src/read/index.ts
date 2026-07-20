// src/read/index.ts
export { peek } from './peek.js';
export type { PeekOptions } from './peek.js';
export type { PeekResult, ReadResult, Decoder } from './types.js';

import type { ReadResult } from './types.js';
import { safeFetch } from '../discovery/fetch.js';
import { findDecoder } from './decoders/index.js';
import { parseHead, extractContent } from './extract.js';
import { detectChallengePage } from './challenge.js';
import { scanRawHtml } from './scan.js';
import { appendFinding } from '../trapaware/audit.js';
import { assertSsrfBypassAllowed } from '../skill/ssrf.js';

export interface ReadOptions {
  skipSsrf?: boolean;
  /** Envelope size bound: links shrink first, then content is re-sliced
   *  byte-accurately (with a contentTruncated signal) until the serialized
   *  envelope fits. Only fixed metadata — including scanner findings —
   *  larger than the budget itself can still exceed it. */
  maxBytes?: number;
  /** Enable trap-aware content scanning on fetched HTML. Default: true.
   *  When false, the scanner does not run and the ReadResult has no
   *  `findings` field (byte-identical to pre-v1.0 output). */
  scan?: boolean;
  /** Include the images array in the envelope (deduped, capped). Default: false. */
  includeImages?: boolean;
  /** Testing-only override for a decoder's API base URL. Forwarded to the
   *  matched decoder so tests can point it at a local fixture server. */
  _apiBaseUrl?: string;
}

const LINKS_CAP = 100;
const IMAGES_CAP = 50;

/**
 * Fit a ReadResult envelope inside maxBytes (issue #62 semantics): shrink the
 * links array by halving first, then binary-search the largest content prefix
 * whose fully serialized envelope fits. Byte-accurate — measured against
 * JSON.stringify(envelope), so any field already on the object (findings,
 * envelopeBytes placeholder, cost) is counted. Sets contentTruncated when the
 * content had to be cut. Applied to BOTH the generic and decoder return paths
 * so maxBytes is one hard cap everywhere. No-op when maxBytes is undefined.
 * Callers record envelopeBytes and recompute cost.tokens after this returns.
 */
function fitReadEnvelope(envelope: ReadResult, maxBytes: number | undefined): void {
  if (maxBytes) {
    // cost.tokens is recomputed by the caller after this returns; measure with
    // its widest possible value here so the final (smaller) number never grows
    // the envelope past the budget we just enforced.
    envelope.cost.tokens = Math.ceil(maxBytes / 4);

    // Shrink links (halving) before touching content.
    while (
      Buffer.byteLength(JSON.stringify(envelope), 'utf-8') > maxBytes &&
      envelope.links.length > 0
    ) {
      const keep = Math.floor(envelope.links.length / 2);
      envelope.linksOmitted = (envelope.linksOmitted ?? 0) + (envelope.links.length - keep);
      envelope.links = envelope.links.slice(0, keep);
    }

    // Links exhausted but still over budget: binary-search the largest content
    // prefix whose full envelope fits (issue #62). Byte-accurate. Only fixed
    // metadata larger than maxBytes itself can still overshoot.
    if (
      Buffer.byteLength(JSON.stringify(envelope), 'utf-8') > maxBytes &&
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
        if (Buffer.byteLength(JSON.stringify(envelope), 'utf-8') <= maxBytes) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
      envelope.content = full.slice(0, lo) + suffix;
    }
  }
}

/**
 * Record envelopeBytes (fixed-width placeholder trick) and recompute cost.tokens
 * as the final mutations, in that order — cost.tokens is last so it stays an
 * exact measure of the settled envelope. Shared by both read return paths.
 */
function fitAndFinalize(envelope: ReadResult, maxBytes: number | undefined): void {
  envelope.envelopeBytes = 999_999_999; // placeholder counted by the re-slice budget
  fitReadEnvelope(envelope, maxBytes);
  envelope.envelopeBytes = Buffer.byteLength(JSON.stringify(envelope), 'utf-8');
  envelope.cost = { tokens: Math.ceil(JSON.stringify(envelope).length / 4) };
}

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
  assertSsrfBypassAllowed(options.skipSsrf);
  const scanEnabled = options.scan !== false;

  // Try site-specific decoder first
  const decoder = findDecoder(url);
  if (decoder) {
    const result = await decoder.decode(url, {
      skipSsrf: options.skipSsrf,
      ...(options._apiBaseUrl ? { _apiBaseUrl: options._apiBaseUrl } : {}),
    });
    if (result) {
      // Cheap first pass: char-slice to roughly bound content, then run the
      // same byte-accurate envelope diet the generic path uses (grok P0-1:
      // decoder results must honour maxBytes as a hard cap, not just a
      // character slice, and must report envelopeBytes like every other path).
      if (options.maxBytes && result.content.length > options.maxBytes) {
        result.content = result.content.slice(0, options.maxBytes);
        result.contentTruncated = true;
      }
      fitAndFinalize(result, options.maxBytes);
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

  // Bot-challenge interstitial (Reddit "please wait for verification",
  // Cloudflare "Just a moment…"): a 200 whose body is a verification page,
  // not content. Label it honestly instead of returning an empty success.
  const challenge = detectChallengePage(html, head.ogTitle || head.title || null);

  // Determine source
  let source: string;
  if (challenge) {
    source = 'challenge-page';
  } else if (body.isSpaShell) {
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

  // Never hand back an empty success for a challenge page — say what happened.
  if (challenge && content.trim().length === 0) {
    content = `[bot-challenge interstitial (${challenge}): the site withheld content pending human verification — no real page content was served]`;
  }

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
      ...(challenge ? { botProtection: challenge } : {}),
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
    ...(challenge ? { botProtection: challenge } : {}),
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

  // maxBytes bounds the envelope: shrink links (halving) before touching
  // content. envelopeBytes is measured with a fixed-width placeholder so its
  // own bytes are budgeted during the diet, then overwritten with the real
  // serialized size (fitReadEnvelope also recomputes cost.tokens).
  fitAndFinalize(envelope, options.maxBytes);
  return envelope;
}
