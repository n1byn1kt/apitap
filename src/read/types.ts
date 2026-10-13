// src/read/types.ts
import type { ReadFinding } from '../trapaware/types.js';

export interface PeekResult {
  url: string;
  status: number;
  accessible: boolean;
  contentType: string | null;
  server: string | null;
  framework: string | null;
  botProtection: string | null;
  signals: string[];
  /** 'error' = client-side transport failure (timeout, headers overflow) — the site did NOT block us. */
  recommendation: 'read' | 'capture' | 'auth_required' | 'blocked' | 'not_found' | 'error';
}

export interface ReadResult {
  url: string;
  title: string | null;
  author: string | null;
  description: string | null;
  content: string;
  links: Array<{ text: string; href: string }>;
  images: Array<{ alt: string; src: string }>;
  /** Number of links dropped by dedupe/caps. Absent on the legacy (scan: false) path. */
  linksOmitted?: number;
  /** Number of images dropped (all of them unless includeImages). Absent on the legacy path. */
  imagesOmitted?: number;
  /** True when content was cut to fit maxBytes. Absent on the legacy path. */
  contentTruncated?: boolean;
  /** Set when the page is a bot-challenge interstitial ('cloudflare',
   *  'ddos-guard', or generic 'challenge') — the site withheld real content.
   *  metadata.source is 'challenge-page' in that case. */
  botProtection?: string;
  /** Set when no readable body came back because the page needs a browser:
   *  it renders client-side (og-tags-only, spa-shell), redirects via script
   *  (js-redirect), or is a bot challenge (challenge-page). Agents should not
   *  treat the content as the page — use `apitap capture` instead (#97). */
  needsBrowser?: true;
  /** One-line guidance accompanying needsBrowser. */
  hint?: string;
  metadata: {
    type: string;
    publishedAt: string | null;
    source: string;
    canonical: string | null;
    siteName: string | null;
  };
  cost: { tokens: number };
  /** Actual serialized size of this envelope in bytes, recorded after the
   *  maxBytes diet runs. When maxBytes was set, this is ≤ maxBytes (modulo the
   *  fixed-width placeholder used during measurement). Absent only on the
   *  legacy non-decoder (scan: false) path — decoder URLs always run the
   *  finalize helper regardless of the scan flag. */
  envelopeBytes?: number;
  /** Trap scanner findings. Present when the scanner ran. Absent when scan: false. */
  findings?: ReadFinding[];
}

export interface Decoder {
  name: string;
  patterns: RegExp[];
  decode(url: string, options?: { skipSsrf?: boolean; [key: string]: any }): Promise<ReadResult | null>;
}

/** Why read() produced no result (#100). */
export interface ReadFailure {
  /** 'http_status' = the site answered non-200; 'ssrf' = our policy blocked the
   *  target; 'transport' = network/client failure (timeout, DNS, overflow). */
  cause: 'http_status' | 'ssrf' | 'transport';
  /** HTTP status when cause is 'http_status'. */
  status?: number;
  /** Transport/SSRF error code (TIMEOUT, ENOTFOUND, SSRF_BLOCKED, …). */
  code?: string;
  /** Bot-protection vendor detected on the failing response, if any. */
  botProtection?: string;
  message: string;
}
