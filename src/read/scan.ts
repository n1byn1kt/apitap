// src/read/scan.ts
import type { ReadFinding, HiddenBy } from '../trapaware/types.js';
import { matchTier1, matchTier2 } from '../trapaware/signatures.js';

const MAX_EXCERPT_LENGTH = 80;
const MIN_SUBSTANTIVE_LENGTH = 8;

/** Count of non-whitespace chars in a string. */
function nonWhitespaceLength(s: string): number {
  return s.replace(/\s+/g, '').length;
}

/** Truncate content for audit log excerpt, collapsing whitespace first. */
function truncateExcerpt(s: string): string {
  const collapsed = s.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= MAX_EXCERPT_LENGTH) return collapsed;
  return collapsed.slice(0, MAX_EXCERPT_LENGTH - 3) + '...';
}

/** Strip tags inside a span of HTML, leaving text content only. */
function stripTagsInRange(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

/**
 * Detect inline style attribute indicating the element is hidden.
 * Returns the HiddenBy token or null.
 */
function detectHiddenByStyle(styleAttr: string): HiddenBy | null {
  const s = styleAttr.toLowerCase();
  if (/\bdisplay\s*:\s*none\b/.test(s)) return 'inline_style_display_none';
  if (/\bvisibility\s*:\s*hidden\b/.test(s)) return 'inline_style_visibility_hidden';
  if (/\bopacity\s*:\s*0(\.0+)?\b/.test(s)) return 'inline_style_opacity_zero';
  if (/\bfont-size\s*:\s*0(px|em|rem|%)?\b/.test(s)) return 'inline_style_font_size_zero';
  // Off-viewport: negative position with at least 3-digit magnitude.
  if (/\b(left|top)\s*:\s*-\d{3,}px\b/.test(s)) return 'inline_style_offscreen';
  return null;
}

/** Regex to match any element opening tag capturing tag name + attribute string. */
const TAG_OPEN_RE = /<([a-zA-Z][a-zA-Z0-9-]*)\s+([^>]*?)\s*\/?>/g;
const COMMENT_RE = /<!--([\s\S]*?)-->/g;

/**
 * Scan raw HTML for hidden content that matches Tier 1 or Tier 2 markers.
 * Returns an array of findings, empty when clean.
 *
 * Two-condition gate: a finding is emitted ONLY when content is in a hidden
 * position (via inline style, hidden attribute, aria-hidden, or HTML comment)
 * AND the content matches an instruction-shape marker.
 */
export function scanRawHtml(raw: string): ReadFinding[] {
  const findings: ReadFinding[] = [];
  scanHtmlComments(raw, findings);
  scanHiddenElements(raw, findings);
  return findings;
}

/**
 * Scan HTML comments. Each comment body is treated as hidden content;
 * if it contains a marker, emit a finding.
 */
function scanHtmlComments(raw: string, out: ReadFinding[]): void {
  for (const m of raw.matchAll(COMMENT_RE)) {
    const body = m[1];
    const offset = m.index ?? 0;
    if (nonWhitespaceLength(body) < MIN_SUBSTANTIVE_LENGTH) continue;
    const tier1 = matchTier1(body);
    const tier2 = !tier1 && matchTier2(body);
    if (!tier1 && !tier2) continue;
    out.push({
      source: 'read',
      scanner: tier1 ? 'hidden_role_marker' : 'hidden_known_signature',
      severity: 'medium',
      hiddenBy: 'html_comment',
      location: {
        offset,
        length: m[0].length,
        surroundingTag: null,
      },
      excerpt: truncateExcerpt(body),
      rationale: tier1
        ? 'HTML comment contains an explicit role marker'
        : 'HTML comment contains a known prompt-injection signature',
    });
  }
}

/**
 * Scan element opening tags for hiding mechanisms. For each hidden element,
 * extract text content and check for markers.
 */
function scanHiddenElements(raw: string, out: ReadFinding[]): void {
  for (const m of raw.matchAll(TAG_OPEN_RE)) {
    const tagName = m[1].toLowerCase();
    const attrs = m[2];
    const tagStart = m.index ?? 0;
    const tagEnd = tagStart + m[0].length;

    const hiddenBy = detectElementHidden(attrs);
    if (!hiddenBy) continue;

    // Find the element's text content: everything up to the matching close tag,
    // stripped of nested tags. This is best-effort for regex-based parsing.
    const closeTag = `</${tagName}>`;
    const closeIdx = raw.toLowerCase().indexOf(closeTag.toLowerCase(), tagEnd);
    const innerHtml = closeIdx === -1
      ? raw.slice(tagEnd, Math.min(raw.length, tagEnd + 2000))
      : raw.slice(tagEnd, closeIdx);
    const textContent = stripTagsInRange(innerHtml);

    if (nonWhitespaceLength(textContent) < MIN_SUBSTANTIVE_LENGTH) continue;

    const tier1 = matchTier1(textContent);
    const tier2 = !tier1 && matchTier2(textContent);
    if (!tier1 && !tier2) continue;

    out.push({
      source: 'read',
      scanner: tier1 ? 'hidden_role_marker' : 'hidden_known_signature',
      severity: 'medium',
      hiddenBy,
      location: {
        offset: tagStart,
        length: (closeIdx === -1 ? tagEnd : closeIdx + closeTag.length) - tagStart,
        surroundingTag: tagName,
      },
      excerpt: truncateExcerpt(textContent),
      rationale: tier1
        ? `${hiddenBy} element contains an explicit role marker`
        : `${hiddenBy} element contains a known prompt-injection signature`,
    });
  }
}

/**
 * Check an element's attribute string for a hiding mechanism.
 * Priority: inline style → aria-hidden → hidden attribute.
 */
function detectElementHidden(attrs: string): HiddenBy | null {
  // Inline style
  const styleMatch = attrs.match(/\bstyle\s*=\s*["']([^"']*)["']/i);
  if (styleMatch) {
    const styleHit = detectHiddenByStyle(styleMatch[1]);
    if (styleHit) return styleHit;
  }
  // aria-hidden="true"
  if (/\baria-hidden\s*=\s*["']true["']/i.test(attrs)) return 'aria_hidden';
  // hidden attribute (valueless or hidden="hidden"/"true")
  if (/\bhidden\b(?!-)(?:\s|=|$|>)/i.test(attrs)) return 'hidden_attribute';
  return null;
}
