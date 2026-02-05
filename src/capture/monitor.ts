// src/capture/monitor.ts
import { chromium, type Browser, type Page } from 'playwright';
import { shouldCapture } from './filter.js';
import { SkillGenerator } from '../skill/generator.js';
import type { CapturedExchange } from '../types.js';

export interface CaptureOptions {
  url: string;
  port?: number;
  launch?: boolean;
  attach?: boolean;
  duration?: number;
  onEndpoint?: (endpoint: { id: string; method: string; path: string }) => void;
  onFiltered?: () => void;
}

export interface CaptureResult {
  generators: Map<string, SkillGenerator>;
  totalRequests: number;
  filteredRequests: number;
}

const DEFAULT_CDP_PORTS = [18792, 18800, 9222];

async function connectToBrowser(options: CaptureOptions): Promise<{ browser: Browser; launched: boolean }> {
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

  const browser = await chromium.launch({ headless: false });
  return { browser, launched: true };
}

export async function capture(options: CaptureOptions): Promise<CaptureResult> {
  const { browser, launched } = await connectToBrowser(options);
  const generators = new Map<string, SkillGenerator>();
  let totalRequests = 0;
  let filteredRequests = 0;

  let page: Page;
  if (launched) {
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

    if (!shouldCapture({ url, status, contentType })) {
      filteredRequests++;
      const hostname = safeHostname(url);
      if (hostname) {
        const gen = generators.get(hostname);
        if (gen) gen.recordFiltered();
      }
      options.onFiltered?.();
      return;
    }

    try {
      const body = await response.text();
      const hostname = new URL(url).hostname;

      if (!generators.has(hostname)) {
        generators.set(hostname, new SkillGenerator());
      }
      const gen = generators.get(hostname)!;

      const exchange: CapturedExchange = {
        request: {
          url,
          method: response.request().method(),
          headers: response.request().headers(),
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
      }
    } catch {
      // Response body may not be available (e.g. redirects); skip silently
    }
  });

  await page.goto(options.url, { waitUntil: 'domcontentloaded' });

  // Wait for duration or until interrupted
  if (options.duration) {
    await new Promise(resolve => setTimeout(resolve, options.duration! * 1000));
  } else {
    // Wait indefinitely — caller handles SIGINT
    await new Promise(resolve => {
      process.once('SIGINT', resolve);
    });
  }

  if (launched) {
    await browser.close();
  }

  return { generators, totalRequests, filteredRequests };
}

function safeHostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
