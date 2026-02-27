// src/capture/monitor.ts
import { chromium, type Browser, type Page } from 'playwright';
import { shouldCapture } from './filter.js';
import { isDomainMatch } from './domain.js';
import { SkillGenerator, type GeneratorOptions } from '../skill/generator.js';
import { IdleTracker } from './idle.js';
import { detectCaptcha } from '../auth/refresh.js';
import { launchBrowser } from './browser.js';
import type { CapturedExchange } from '../types.js';

export interface CaptureOptions {
  url: string;
  port?: number;
  launch?: boolean;
  attach?: boolean;
  headless?: boolean;  // default: false (interactive capture shows browser)
  duration?: number;
  allDomains?: boolean;
  enablePreview?: boolean;
  scrub?: boolean;
  onEndpoint?: (endpoint: { id: string; method: string; path: string }) => void;
  onFiltered?: () => void;
  onIdle?: () => void;
}

export interface CaptureResult {
  generators: Map<string, SkillGenerator>;
  totalRequests: number;
  filteredRequests: number;
  domBytes?: number; // v1.0: measured DOM size for browser cost comparison
}

const DEFAULT_CDP_PORTS = [18792, 18800, 9222];

async function connectToBrowser(options: CaptureOptions): Promise<{ browser: Browser; launched: boolean; launchContext?: import('playwright').BrowserContext }> {
  if (!options.launch) {
    const ports = options.port ? [options.port] : DEFAULT_CDP_PORTS;
    for (const port of ports) {
      try {
        const browser = await chromium.connectOverCDP(`http://localhost:${port}`, { timeout: 3000 });
        return { browser, launched: false };
      } catch {
        continue;
      }
    }
  }

  if (options.attach) {
    const ports = options.port ? [options.port] : DEFAULT_CDP_PORTS;
    throw new Error(`No browser found on CDP ports: ${ports.join(', ')}. Is a Chromium browser running with remote debugging?`);
  }

  const { browser, context } = await launchBrowser({ headless: options.headless ?? (process.env.DISPLAY ? false : true) });
  return { browser, launched: true, launchContext: context };
}

export async function capture(options: CaptureOptions): Promise<CaptureResult> {
  const { browser, launched, launchContext } = await connectToBrowser(options);
  const generators = new Map<string, SkillGenerator>();
  let totalRequests = 0;
  let filteredRequests = 0;
  const captchaDetectedDomains = new Set<string>();

  // Extract target domain for domain-only filtering
  const targetUrl = options.url;

  const generatorOptions: GeneratorOptions = {
    enablePreview: options.enablePreview ?? false,
    scrub: options.scrub ?? true,
  };

  // Idle tracking: only active during interactive capture (no --duration)
  const idleTracker = !options.duration ? new IdleTracker() : null;
  let idleInterval: ReturnType<typeof setInterval> | null = null;

  let page: Page;
  if (launched && launchContext) {
    page = await launchContext.newPage();
  } else if (launched) {
    // Fallback: shouldn't happen, but handle gracefully
    const context = await browser.newContext();
    page = await context.newPage();
  } else {
    const contexts = browser.contexts();
    if (contexts.length > 0 && contexts[0].pages().length > 0) {
      page = contexts[0].pages()[0];
    } else {
      const context = contexts[0] ?? await browser.newContext();
      page = await context.newPage();
    }
  }

  page.on('response', async (response) => {
    totalRequests++;

    const url = response.url();
    const status = response.status();
    const contentType = response.headers()['content-type'] ?? '';

    // Domain-only filtering (before any other processing)
    if (!options.allDomains) {
      const hostname = safeHostname(url);
      if (hostname && !isDomainMatch(hostname, targetUrl)) {
        filteredRequests++;
        options.onFiltered?.();
        return;
      }
    }

    if (!shouldCapture({ url, status, contentType })) {
      filteredRequests++;
      const hostname = safeHostname(url);
      if (hostname) {
        const gen = generators.get(hostname);
        if (gen) gen.recordFiltered();
      }
      // Track network bytes from headers for filtered responses (browser cost measurement)
      const contentLength = parseInt(response.headers()['content-length'] ?? '0', 10);
      if (contentLength > 0) {
        const filteredHostname = safeHostname(url);
        if (filteredHostname && generators.has(filteredHostname)) {
          generators.get(filteredHostname)!.addNetworkBytes(contentLength);
        }
      }
      options.onFiltered?.();
      return;
    }

    try {
      const body = await response.text();
      const hostname = new URL(url).hostname;

      // Check for captcha in HTML responses (v0.8 captcha risk detection)
      if (contentType.includes('text/html') && detectCaptcha(body)) {
        captchaDetectedDomains.add(hostname);
      }

      if (!generators.has(hostname)) {
        generators.set(hostname, new SkillGenerator(generatorOptions));
      }
      const gen = generators.get(hostname)!;

      const exchange: CapturedExchange = {
        request: {
          url,
          method: response.request().method(),
          headers: response.request().headers(),
          postData: response.request().postData() ?? undefined,
        },
        response: {
          status,
          headers: response.headers(),
          body,
          contentType,
        },
        timestamp: new Date().toISOString(),
      };

      const endpoint = gen.addExchange(exchange);
      if (endpoint) {
        options.onEndpoint?.({ id: endpoint.id, method: endpoint.method, path: endpoint.path });

        // Track for idle detection using parameterized key
        if (idleTracker) {
          const paramKey = `${endpoint.method} ${endpoint.path}`;
          idleTracker.recordEndpoint(paramKey);
        }
      }
    } catch {
      // Response body may not be available (e.g. redirects); skip silently
    }
  });

  await page.goto(options.url, { waitUntil: 'domcontentloaded' });

  // Start idle check interval (every 5s) for interactive capture
  if (idleTracker && options.onIdle) {
    idleInterval = setInterval(() => {
      if (idleTracker.checkIdle()) {
        options.onIdle!();
      }
    }, 5000);
  }

  // Wait for duration or until interrupted
  // SIGINT always resolves gracefully so skill files get written
  if (options.duration) {
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, options.duration! * 1000);
      process.once('SIGINT', () => { clearTimeout(timer); resolve(); });
    });
  } else {
    await new Promise<void>(resolve => {
      process.once('SIGINT', resolve);
    });
  }

  // Clean up idle interval
  if (idleInterval) clearInterval(idleInterval);

  // Measure DOM size for browser cost comparison (v1.0)
  let domBytes: number | undefined;
  try {
    const html = await page.content();
    domBytes = html.length;
  } catch { /* page may have navigated away */ }

  if (launched) {
    await browser.close();
  }

  // Mark generators for domains where captcha was detected
  for (const [hostname, gen] of generators) {
    if (captchaDetectedDomains.has(hostname)) {
      gen.setCaptchaRisk(true);
    }
  }

  return { generators, totalRequests, filteredRequests, domBytes };
}

function safeHostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
