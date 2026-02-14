// src/discovery/index.ts
import type { DiscoveryResult, SkillFile, SkillEndpoint, DetectedFramework } from '../types.js';
import { validateUrl } from '../skill/ssrf.js';
import { safeFetch } from './fetch.js';
import { detectFrameworks } from './frameworks.js';
import { discoverSpecs, parseSpecToSkillFile } from './openapi.js';
import { probeApiPaths } from './probes.js';
import { detectAuthRequired } from './auth.js';

export interface DiscoveryOptions {
  timeout?: number;         // overall timeout in ms (default: 30000)
  skipProbes?: boolean;     // skip API path probing
  skipSpecs?: boolean;      // skip OpenAPI spec discovery
  skipFrameworks?: boolean; // skip framework detection
  skipSsrf?: boolean;       // bypass SSRF check (for testing with local servers)
}

/**
 * Run smart discovery on a URL to detect APIs without launching a browser.
 *
 * Flow:
 * 1. SSRF validation
 * 2. Fetch homepage HTML + headers
 * 3. Run detection strategies in parallel:
 *    - Framework detection (from HTML/headers)
 *    - OpenAPI spec discovery (probe common paths)
 *    - Common API pattern probing
 * 4. Synthesize results into a DiscoveryResult
 */
export async function discover(
  url: string,
  options: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const start = Date.now();
  const fullUrl = url.startsWith('http') ? url : `https://${url}`;

  // SSRF check
  if (!options.skipSsrf) {
    const ssrfResult = validateUrl(fullUrl);
    if (!ssrfResult.safe) {
      return {
        confidence: 'none',
        hints: [`SSRF blocked: ${ssrfResult.reason}`],
        duration: Date.now() - start,
      };
    }
  }

  let domain: string;
  let origin: string;
  try {
    const parsed = new URL(fullUrl);
    domain = parsed.hostname;
    origin = parsed.origin;
  } catch {
    return {
      confidence: 'none',
      hints: ['Invalid URL'],
      duration: Date.now() - start,
    };
  }

  // Fetch homepage
  const homepage = await safeFetch(fullUrl, { timeout: options.timeout ?? 10000, skipSsrf: options.skipSsrf });
  if (!homepage) {
    return {
      confidence: 'none',
      hints: ['Failed to fetch homepage — site may be down or blocking requests'],
      duration: Date.now() - start,
    };
  }

  const ssrfOpts = { skipSsrf: options.skipSsrf };

  // Auth detection (runs on homepage HTML + headers)
  const authResult = detectAuthRequired(homepage.body, fullUrl, homepage.headers);
  const authFields = authResult.authRequired ? {
    authRequired: true as const,
    authSignals: authResult.signals,
    ...(authResult.loginUrl ? { loginUrl: authResult.loginUrl } : {}),
  } : {};

  // Run all detection strategies in parallel
  const [frameworks, specs, probes] = await Promise.all([
    options.skipFrameworks
      ? []
      : detectFrameworks({ html: homepage.body, headers: homepage.headers, url: fullUrl }),
    options.skipSpecs
      ? []
      : discoverSpecs(origin, homepage.headers, ssrfOpts),
    options.skipProbes
      ? []
      : probeApiPaths(origin, ssrfOpts),
  ]);

  const hints: string[] = [];

  // Strategy 1: OpenAPI spec found → parse into skill file (highest confidence)
  if (specs.length > 0) {
    const bestSpec = specs[0];
    const skillFile = await parseSpecToSkillFile(bestSpec.url, domain, origin, ssrfOpts);
    if (skillFile && skillFile.endpoints.length > 0) {
      hints.push(`OpenAPI spec found at ${bestSpec.url} (${bestSpec.version})`);
      if (frameworks.length > 0) hints.push(`Framework: ${frameworks.map(f => f.name).join(', ')}`);
      addProbeHints(hints, probes);

      return {
        confidence: 'high',
        skillFile,
        hints,
        frameworks: frameworks.length > 0 ? frameworks : undefined,
        specs,
        probes: probes.length > 0 ? probes : undefined,
        duration: Date.now() - start,
        ...authFields,
      };
    }
  }

  // Strategy 2: Framework detected → generate skeleton skill file
  const highConfidence = frameworks.filter(f => f.confidence === 'high');
  if (highConfidence.length > 0) {
    const skillFile = buildFrameworkSkillFile(domain, origin, highConfidence);
    hints.push(`Detected: ${highConfidence.map(f => f.name).join(', ')}`);
    addProbeHints(hints, probes);
    if (specs.length > 0) hints.push(`Spec found but could not parse: ${specs.map(s => s.url).join(', ')}`);

    return {
      confidence: 'medium',
      skillFile,
      hints,
      frameworks,
      specs: specs.length > 0 ? specs : undefined,
      probes: probes.length > 0 ? probes : undefined,
      duration: Date.now() - start,
      ...authFields,
    };
  }

  // Strategy 3: Medium-confidence framework or API probes found → hints only
  const apiProbes = probes.filter(p => p.isApi);
  const mediumFrameworks = frameworks.filter(f => f.confidence === 'medium');

  if (mediumFrameworks.length > 0 || apiProbes.length > 0) {
    if (mediumFrameworks.length > 0) {
      const skillFile = buildFrameworkSkillFile(domain, origin, mediumFrameworks);
      hints.push(`Possibly: ${mediumFrameworks.map(f => f.name).join(', ')}`);
      addProbeHints(hints, probes);

      return {
        confidence: 'low',
        skillFile,
        hints,
        frameworks,
        probes: probes.length > 0 ? probes : undefined,
        duration: Date.now() - start,
        ...authFields,
      };
    }

    // Only probes found
    hints.push('API paths detected via probing');
    addProbeHints(hints, probes);

    return {
      confidence: 'low',
      hints,
      frameworks: frameworks.length > 0 ? frameworks : undefined,
      probes,
      duration: Date.now() - start,
      ...authFields,
    };
  }

  // Nothing found
  if (frameworks.length > 0) {
    hints.push(`Low-confidence signals: ${frameworks.map(f => f.name).join(', ')}`);
  }
  hints.push('No API patterns detected — auto-capture recommended');

  return {
    confidence: 'none',
    hints,
    frameworks: frameworks.length > 0 ? frameworks : undefined,
    probes: probes.length > 0 ? probes : undefined,
    duration: Date.now() - start,
    ...authFields,
  };
}

function addProbeHints(hints: string[], probes: import('../types.js').ProbeResult[]): void {
  const apiProbes = probes.filter(p => p.isApi);
  if (apiProbes.length > 0) {
    hints.push(`API paths found: ${apiProbes.map(p => `${p.path} (${p.status})`).join(', ')}`);
  }
}

/**
 * Build a skeleton skill file from detected frameworks.
 * Endpoints are unverified predictions — replayability is 'unknown'.
 */
function buildFrameworkSkillFile(
  domain: string,
  baseUrl: string,
  frameworks: DetectedFramework[],
): SkillFile {
  const endpoints: SkillEndpoint[] = [];
  const seen = new Set<string>();

  for (const framework of frameworks) {
    for (const pattern of framework.apiPatterns) {
      const key = `GET ${pattern}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const id = generateId('GET', pattern);
      endpoints.push({
        id,
        method: 'GET',
        path: pattern,
        queryParams: {},
        headers: {},
        responseShape: { type: 'unknown' },
        examples: {
          request: { url: `${baseUrl}${pattern}`, headers: {} },
          responsePreview: null,
        },
        replayability: {
          tier: 'unknown',
          verified: false,
          signals: [`discovered-from-${framework.name.toLowerCase()}`],
        },
      });
    }
  }

  return {
    version: '1.2',
    domain,
    capturedAt: new Date().toISOString(),
    baseUrl,
    endpoints,
    metadata: {
      captureCount: 0,
      filteredCount: 0,
      toolVersion: '1.0.0',
    },
    provenance: 'unsigned',
  };
}

function generateId(method: string, path: string): string {
  const segments = path.split('/').filter(s => s !== '' && !s.startsWith(':'));
  const slug = segments.join('-').replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'root';
  return `${method.toLowerCase()}-${slug}`;
}
