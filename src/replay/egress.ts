// src/replay/egress.ts
import type {
  EgressFinding,
  EgressScanner,
  ParamLocation,
  Severity,
} from '../trapaware/types.js';

/**
 * Request shape passed to the egress scanner. Headers are deliberately
 * excluded — in APITAP's architecture the agent cannot add headers, so
 * scanning them would be checking trusted content.
 */
export interface OutboundRequest {
  url: string;
  method: string;
  body?: string;
  contentType?: string;
  domain: string;
  requestPath: string;
}

/** Internal: a pattern definition with its matcher metadata. */
interface Pattern {
  scanner: EgressScanner;
  re: RegExp;
  severity: Severity;
  rationale: string;
  /** Optional post-match validator. When present, a regex match is only
   *  promoted to a finding if the validator returns true. Used for
   *  patterns like credit cards that need checksum validation to avoid
   *  firing on arbitrary 16-digit sequences (order numbers, IDs, etc.). */
  validator?: (match: string) => boolean;
}

/**
 * Luhn checksum for credit card numbers. Accepts 13-19 digit sequences
 * (standard PAN range) after stripping non-digit characters. Returns true
 * if the sequence is a valid Luhn-checksum number.
 */
function luhnCheck(input: string): boolean {
  const clean = input.replace(/[^0-9]/g, '');
  if (clean.length < 13 || clean.length > 19) return false;
  let sum = 0;
  let alternate = false;
  for (let i = clean.length - 1; i >= 0; i--) {
    let n = parseInt(clean[i], 10);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

/**
 * Secret and PII patterns. All are either fixed-prefix-anchored or
 * context-gated — no generic high-entropy catchall. All patterns have
 * the /g flag for use with String.prototype.matchAll.
 */
const STANDALONE_PATTERNS: readonly Pattern[] = Object.freeze([
  {
    scanner: 'secret_ssh_private_key',
    re: /-----BEGIN (?:RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    severity: 'high',
    rationale: 'SSH private key header detected',
  },
  {
    scanner: 'secret_pgp_private_key',
    re: /-----BEGIN PGP PRIVATE KEY BLOCK-----/g,
    severity: 'high',
    rationale: 'PGP private key header detected',
  },
  {
    scanner: 'secret_aws_access_key',
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    severity: 'high',
    rationale: 'AWS access key pattern matched',
  },
  {
    scanner: 'secret_github_classic_pat',
    re: /\bghp_[A-Za-z0-9]{36}\b/g,
    severity: 'high',
    rationale: 'GitHub classic personal access token matched',
  },
  {
    scanner: 'secret_github_oauth_token',
    re: /\bgho_[A-Za-z0-9]{36}\b/g,
    severity: 'high',
    rationale: 'GitHub OAuth access token matched',
  },
  {
    scanner: 'secret_github_user_to_server',
    re: /\bghu_[A-Za-z0-9]{36}\b/g,
    severity: 'high',
    rationale: 'GitHub App user-to-server token matched',
  },
  {
    scanner: 'secret_github_server_to_server',
    re: /\bghs_[A-Za-z0-9]{36}\b/g,
    severity: 'high',
    rationale: 'GitHub App server-to-server token matched (includes Actions GITHUB_TOKEN)',
  },
  {
    scanner: 'secret_github_refresh_token',
    re: /\bghr_[A-Za-z0-9]{36}\b/g,
    severity: 'high',
    rationale: 'GitHub App refresh token matched',
  },
  {
    scanner: 'secret_github_fine_grained_pat',
    re: /\bgithub_pat_[A-Za-z0-9_]{82}\b/g,
    severity: 'high',
    rationale: 'GitHub fine-grained personal access token matched',
  },
  {
    scanner: 'secret_openai_key',
    re: /\bsk-[A-Za-z0-9]{48}\b/g,
    severity: 'high',
    rationale: 'OpenAI API key pattern matched',
  },
  {
    scanner: 'secret_anthropic_key',
    re: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/g,
    severity: 'high',
    rationale: 'Anthropic API key pattern matched',
  },
  {
    scanner: 'secret_slack_token',
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    severity: 'high',
    rationale: 'Slack token pattern matched',
  },
  {
    scanner: 'secret_npm_token',
    re: /\bnpm_[A-Za-z0-9]{36}\b/g,
    severity: 'high',
    rationale: 'npm auth token pattern matched',
  },
  {
    scanner: 'secret_tailscale_auth_key',
    re: /\btskey-auth-[A-Za-z0-9-]+\b/g,
    severity: 'high',
    rationale: 'Tailscale auth key pattern matched',
  },
  {
    scanner: 'pii_email',
    re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    severity: 'medium',
    rationale: 'Email address detected',
  },
  {
    scanner: 'pii_phone',
    re: /\+[1-9]\d{7,14}|\(\d{3}\)[-.\s]\d{3}[-.\s]\d{4}|\d{3}[-.\s]\d{3}[-.\s]\d{4}/g,
    severity: 'medium',
    rationale: 'Phone number detected',
  },
  {
    scanner: 'pii_ssn',
    re: /\b\d{3}-\d{2}-\d{4}\b/g,
    severity: 'medium',
    rationale: 'US SSN pattern matched',
  },
  {
    scanner: 'pii_credit_card',
    re: /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g,
    severity: 'medium',
    rationale: 'Credit card number pattern matched (Luhn-verified)',
    validator: luhnCheck,
  },
]);

/** Context-gated: AWS secret key (40-char base64) only fires if an AWS access key is also present in the same request. */
const AWS_SECRET_RE = /\b[A-Za-z0-9/+=]{40}\b/g;

/**
 * Scan a single text value and emit findings for every match. The caller
 * provides the parameter location and path so findings are attributable.
 *
 * CRITICAL: findings never include the matched bytes. Only pattern name,
 * match length, and the structural paramPath are recorded.
 */
function scanValue(
  value: string,
  paramLocation: ParamLocation,
  paramPath: string,
  domain: string,
  requestPath: string,
  out: EgressFinding[],
  seenAwsAccessKey: { flag: boolean },
): void {
  for (const p of STANDALONE_PATTERNS) {
    for (const m of value.matchAll(p.re)) {
      // If the pattern has a validator, drop the match if it fails.
      if (p.validator && !p.validator(m[0])) continue;
      out.push({
        source: 'egress',
        scanner: p.scanner,
        severity: p.severity,
        domain,
        requestPath,
        paramLocation,
        paramPath,
        matchLength: m[0].length,
        action: 'pass', // caller assigns final action
        rationale: p.rationale,
      });
      if (p.scanner === 'secret_aws_access_key') {
        seenAwsAccessKey.flag = true;
      }
    }
  }
}

/**
 * Second pass for AWS secret key (context-gated).
 * Only runs if the first pass saw an AWS access key.
 */
function scanAwsSecretKey(
  value: string,
  paramLocation: ParamLocation,
  paramPath: string,
  domain: string,
  requestPath: string,
  out: EgressFinding[],
): void {
  for (const m of value.matchAll(AWS_SECRET_RE)) {
    // Skip if this match is itself the AKIA/ASIA access key (already flagged)
    if (/^(AKIA|ASIA)/.test(m[0])) continue;
    out.push({
      source: 'egress',
      scanner: 'secret_aws_secret_key',
      severity: 'high',
      domain,
      requestPath,
      paramLocation,
      paramPath,
      matchLength: m[0].length,
      action: 'pass',
      rationale: 'AWS secret key pattern matched in context of AWS access key',
    });
  }
}

/** Scan URL query string values. */
function scanUrlQuery(
  url: string,
  domain: string,
  requestPath: string,
  out: EgressFinding[],
  seenAwsAccessKey: { flag: boolean },
): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  for (const [key, value] of parsed.searchParams.entries()) {
    scanValue(value, 'url_query', `query.${key}`, domain, requestPath, out, seenAwsAccessKey);
  }
}

/** Recursively walk a parsed JSON body, scanning string values. */
function walkJson(
  obj: unknown,
  path: string,
  domain: string,
  requestPath: string,
  out: EgressFinding[],
  seenAwsAccessKey: { flag: boolean },
): void {
  if (typeof obj === 'string') {
    scanValue(obj, 'body_json', path, domain, requestPath, out, seenAwsAccessKey);
    return;
  }
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => walkJson(item, `${path}[${i}]`, domain, requestPath, out, seenAwsAccessKey));
    return;
  }
  if (obj !== null && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      walkJson(v, path ? `${path}.${k}` : k, domain, requestPath, out, seenAwsAccessKey);
    }
  }
}

/** Scan the request body, dispatching on content type. */
function scanBody(
  body: string,
  contentType: string | undefined,
  domain: string,
  requestPath: string,
  out: EgressFinding[],
  seenAwsAccessKey: { flag: boolean },
): void {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('application/json')) {
    try {
      const parsed = JSON.parse(body);
      walkJson(parsed, 'body', domain, requestPath, out, seenAwsAccessKey);
      return;
    } catch {
      // Fall through to raw scan
    }
  }
  if (ct.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(body);
    for (const [key, value] of params.entries()) {
      scanValue(value, 'body_form', `body.${key}`, domain, requestPath, out, seenAwsAccessKey);
    }
    return;
  }
  if (ct.includes('multipart/form-data')) {
    // Multipart parsing without a dependency is out of scope for v1.0.
    // Fall back to raw scanning of the full body — less precise but still
    // catches secret patterns inside text parts.
    scanValue(body, 'body_multipart', 'body', domain, requestPath, out, seenAwsAccessKey);
    return;
  }
  // Raw scan for everything else (including text/plain and unknown types)
  scanValue(body, 'body_raw', 'body', domain, requestPath, out, seenAwsAccessKey);
}

/**
 * Scan an outbound request for secret and PII patterns.
 *
 * Returns an array of findings with action set to "pass". The caller
 * (replay engine) is responsible for re-assigning the action based on the
 * effective egress check mode (annotate / block) and for writing findings
 * to the audit log.
 */
export function scanOutboundRequest(req: OutboundRequest): EgressFinding[] {
  const findings: EgressFinding[] = [];
  const seenAwsAccessKey = { flag: false };

  scanUrlQuery(req.url, req.domain, req.requestPath, findings, seenAwsAccessKey);
  if (req.body) {
    scanBody(req.body, req.contentType, req.domain, req.requestPath, findings, seenAwsAccessKey);
  }

  // Context-gated second pass for AWS secret key
  if (seenAwsAccessKey.flag) {
    try {
      const parsed = new URL(req.url);
      for (const [key, value] of parsed.searchParams.entries()) {
        scanAwsSecretKey(value, 'url_query', `query.${key}`, req.domain, req.requestPath, findings);
      }
    } catch { /* ignore */ }
    if (req.body) {
      scanAwsSecretKey(req.body, 'body_raw', 'body', req.domain, req.requestPath, findings);
    }
  }

  return findings;
}
