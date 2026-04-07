// src/trapaware/signatures.ts

/**
 * Tier 1 — Explicit role markers (high signal, near-zero false positive).
 * Line-prefix anchors (case-insensitive, whitespace-leading allowed).
 */
export const TIER1_LINE_PREFIXES: readonly string[] = Object.freeze([
  'system',
  'user',
  'assistant',
  'ai',
  'chatgpt',
  'claude',
  'gemini',
  'model',
  'instruction',
  'instructions',
]);

/**
 * Tier 1 — Structured markers (case-sensitive literal substring match).
 * These are format tokens from LLM prompt templates.
 */
export const TIER1_STRUCTURED_MARKERS: readonly string[] = Object.freeze([
  '[INST]',
  '[/INST]',
  '<|im_start|>',
  '<|im_end|>',
  '<<SYS>>',
  '<</SYS>>',
  '### Instruction',
  '### System',
  '### Response',
]);

/**
 * Tier 2 — Known prompt-injection signatures (literal strings, normalized match).
 * Lowercase + whitespace-collapsed match via String.prototype.includes.
 */
export const TIER2_SIGNATURES: readonly string[] = Object.freeze([
  'ignore previous instructions',
  'ignore all previous instructions',
  'ignore the above instructions',
  'disregard previous instructions',
  'disregard all previous',
  'your new task is',
  'your real task is',
  'you are now',
  'from now on you',
  'pretend you are',
  'act as an unfiltered',
  'output the following verbatim',
  'repeat after me',
  'new instructions:',
  'updated instructions:',
]);

/**
 * Explicitly cut from Tier 2 for v1.0 due to false-positive risk in
 * legitimate prose (even inside the hidden gate). Deferred to v1.1 pending
 * audit log data. This constant exists as a regression guard — any future
 * contributor who adds these to TIER2_SIGNATURES will trip a test.
 */
export const CUT_FROM_TIER2_V1: readonly string[] = Object.freeze([
  'forget everything',
  'do not tell the user',
  'do not mention',
]);

/**
 * Normalize text for Tier 2 matching: lowercase + collapse all whitespace
 * runs to single spaces. Safe for Unicode-basic content; no NFKC in v1.0.
 */
function normalize(input: string): string {
  return input.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Check if input matches any Tier 1 marker.
 * Line-prefix anchors are matched case-insensitively at start-of-line.
 * Structured markers are case-sensitive literal substring matches.
 */
export function matchTier1(input: string): boolean {
  // Structured markers (case-sensitive literal)
  for (const marker of TIER1_STRUCTURED_MARKERS) {
    if (input.includes(marker)) return true;
  }
  // Line prefixes (case-insensitive, must be at start of line or start of string)
  const lines = input.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.replace(/^\s+/, '');
    const lower = trimmed.toLowerCase();
    for (const prefix of TIER1_LINE_PREFIXES) {
      if (lower.startsWith(prefix + ':')) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Check if input matches any Tier 2 signature after normalization.
 */
export function matchTier2(input: string): boolean {
  const normalized = normalize(input);
  for (const sig of TIER2_SIGNATURES) {
    if (normalized.includes(sig)) return true;
  }
  return false;
}
