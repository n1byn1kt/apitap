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

/** A real interstitial carries a sentence or two, never an article. */
const CHALLENGE_MAX_CONTENT = 500;

/**
 * Returns the challenge vendor ('cloudflare', 'ddos-guard', or generic
 * 'challenge') when the page is a bot-verification interstitial, else null.
 */
export function detectChallengePage(
  html: string,
  title: string | null,
  contentLength?: number,
): string | null {
  if (title) {
    for (const { pattern, vendor } of TITLE_PATTERNS) {
      if (pattern.test(title)) return vendor;
    }
  }
  // Cloudflare's challenge-platform script also rides along on ordinary pages
  // that passed (JS detections / managed challenge on later paths): Stack
  // Exchange and census.gov serve 20k+ chars of real content with it. Only a
  // page with little content of its own is the interstitial.
  if (
    html.includes('/cdn-cgi/challenge-platform/') &&
    (contentLength === undefined || contentLength < CHALLENGE_MAX_CONTENT)
  ) return 'cloudflare';
  return null;
}
