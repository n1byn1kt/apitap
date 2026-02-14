// src/capture/scrubber.ts

// Email: standard pattern
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// Phone (international): requires + prefix
const PHONE_INTL_RE = /\+[1-9]\d{7,14}/g;

// Phone (US): requires separators — (123) 456-7890 or 123-456-7890 or 123.456.7890
const PHONE_US_RE = /\(\d{3}\)[-.\s]\d{3}[-.\s]\d{4}|\d{3}[-.\s]\d{3}[-.\s]\d{4}/g;

// IPv4: four octets, each 0-255, validated programmatically
const IPV4_RE = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;

// Credit card: 16 digits with optional dashes or spaces every 4
const CARD_RE = /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g;

// US SSN: 123-45-6789
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;

/**
 * Scrub PII from a string. Returns the string with PII replaced by placeholders.
 * Order matters: SSN before phone (SSN is more specific).
 */
export function scrubPII(input: string): string {
  let result = input;

  // Email first (most distinctive pattern)
  result = result.replace(EMAIL_RE, '[email]');

  // SSN before phone (SSN pattern 123-45-6789 could be confused)
  result = result.replace(SSN_RE, '[ssn]');

  // Credit cards
  result = result.replace(CARD_RE, '[card]');

  // IPv4 with octet validation
  result = result.replace(IPV4_RE, (_match, o1, o2, o3, o4) => {
    const octets = [o1, o2, o3, o4].map(Number);
    if (octets.every(o => o <= 255)) return '[ip]';
    return _match;
  });

  // Phone (international, then US)
  result = result.replace(PHONE_INTL_RE, '[phone]');
  result = result.replace(PHONE_US_RE, '[phone]');

  return result;
}
