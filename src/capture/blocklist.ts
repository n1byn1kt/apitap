// src/capture/blocklist.ts

const BLOCKLIST = new Set([
  // Analytics
  'google-analytics.com',
  'analytics.google.com',
  'googletagmanager.com',
  'segment.io',
  'cdn.segment.com',
  'mixpanel.com',
  'amplitude.com',
  'hotjar.com',
  'heapanalytics.com',
  'plausible.io',
  'posthog.com',
  'clarity.ms',
  'fullstory.com',

  // Ads
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'facebook.net',
  'connect.facebook.net',
  'adsrvr.org',
  'adnxs.com',
  'criteo.com',
  'outbrain.com',
  'taboola.com',

  // Error tracking / monitoring
  'sentry.io',
  'datadoghq.com',
  'browser-intake-datadoghq.com',
  'newrelic.com',
  'bam.nr-data.net',
  'logrocket.com',
  'logr-ingest.com',
  'bugsnag.com',
  'rollbar.com',

  // Social tracking
  'bat.bing.com',
  'ct.pinterest.com',
  'snap.licdn.com',
  'px.ads.linkedin.com',
  'analytics.twitter.com',
  'analytics.tiktok.com',

  // Customer engagement
  'intercom.io',
  'widget.intercom.io',
  'api-iam.intercom.io',
  'zendesk.com',
  'drift.com',
  'crisp.chat',
]);

/**
 * Check if a hostname is on the blocklist.
 * Matches exact hostnames and subdomains of blocklisted domains.
 * e.g. "sentry.io" blocks "o123.ingest.sentry.io"
 */
export function isBlocklisted(hostname: string): boolean {
  if (BLOCKLIST.has(hostname)) return true;

  // Check parent domains: "a.b.sentry.io" → "b.sentry.io" → "sentry.io"
  const parts = hostname.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const parent = parts.slice(i).join('.');
    if (BLOCKLIST.has(parent)) return true;
  }

  return false;
}
