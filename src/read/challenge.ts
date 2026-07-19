// src/read/challenge.ts
//
// Bot-challenge / interstitial detection for the generic read pipeline.
// Sites like Reddit and Cloudflare-fronted pages answer HTTP 200 with a
// human-verification page instead of content. Without detection, read
// reports a green success with empty content — a silent trust failure.
//
// Detection is deliberately title-driven (plus unambiguous vendor markers
// in the HTML) so an article ABOUT captchas never trips it.

const TITLE_PATTERNS: Array<{ pattern: RegExp; vendor: string }> = [
  { pattern: /just a moment/i, vendor: 'cloudflare' },
  { pattern: /attention required!?\s*\|\s*cloudflare/i, vendor: 'cloudflare' },
  { pattern: /ddos-guard/i, vendor: 'ddos-guard' },
  { pattern: /please wait.{0,40}verification|verification.{0,40}please wait/i, vendor: 'challenge' },
  { pattern: /checking your browser/i, vendor: 'challenge' },
  { pattern: /verify(?:ing)? you are (?:a )?human/i, vendor: 'challenge' },
  { pattern: /enable javascript and cookies to continue/i, vendor: 'challenge' },
];

/**
 * Returns the challenge vendor ('cloudflare', 'ddos-guard', or generic
 * 'challenge') when the page is a bot-verification interstitial, else null.
 */
export function detectChallengePage(html: string, title: string | null): string | null {
  if (title) {
    for (const { pattern, vendor } of TITLE_PATTERNS) {
      if (pattern.test(title)) return vendor;
    }
  }
  // Cloudflare's challenge orchestration script path is unique to real
  // challenge pages — never present on ordinary CF-fronted content.
  if (html.includes('/cdn-cgi/challenge-platform/')) return 'cloudflare';
  return null;
}
