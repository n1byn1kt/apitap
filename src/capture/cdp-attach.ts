// src/capture/cdp-attach.ts
import http from 'node:http';
import { homedir } from 'node:os';
import type { CapturedExchange } from '../types.js';
import { shouldCapture } from './filter.js';
import { SkillGenerator } from '../skill/generator.js';
import { signSkillFile } from '../skill/signing.js';
import { writeSkillFile } from '../skill/store.js';
import { AuthManager, getMachineId } from '../auth/manager.js';
import { deriveSigningKey } from '../auth/crypto.js';
import { join } from 'node:path';

// ---- Domain glob matching ----

/**
 * Test if a hostname matches any pattern in a domain glob list.
 * Empty list means "match all" (no filter).
 *
 * Glob rules:
 * - "api.github.com" — exact match
 * - "*.github.com" — matches any subdomain AND the bare domain
 *   (the *. prefix means "zero or more subdomains")
 */
export function matchesDomainGlob(hostname: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true;

  for (const pattern of patterns) {
    if (pattern.startsWith('*.')) {
      const base = pattern.slice(2); // "github.com"
      // Match bare domain or any subdomain
      if (hostname === base || hostname.endsWith('.' + base)) {
        return true;
      }
    } else {
      if (hostname === pattern) return true;
    }
  }
  return false;
}

/**
 * Parse a comma-separated domain pattern string into a list.
 */
export function parseDomainPatterns(input: string | undefined): string[] {
  if (!input || input.trim() === '') return [];
  return input.split(',').map(p => p.trim()).filter(p => p.length > 0);
}

// ---- CDP HTTP discovery ----

function cdpGet<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk: string) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data) as T); }
        catch { reject(new Error(`Invalid JSON from ${url}`)); }
      });
    }).on('error', reject);
  });
}

/**
 * Discover Chrome's browser-level WebSocket URL via the /json/version endpoint.
 */
export async function discoverBrowserWsUrl(port: number): Promise<{
  wsUrl: string;
  browser: string;
  tabCount: number;
}> {
  const versionInfo = await cdpGet<{
    Browser: string;
    webSocketDebuggerUrl: string;
  }>(`http://127.0.0.1:${port}/json/version`);

  const targets = await cdpGet<Array<{ type: string }>>(`http://127.0.0.1:${port}/json/list`);
  const tabCount = targets.filter(t => t.type === 'page').length;

  return {
    wsUrl: versionInfo.webSocketDebuggerUrl,
    browser: versionInfo.Browser,
    tabCount,
  };
}

// ---- CDP WebSocket session ----

/**
 * Minimal CDP session over a single WebSocket.
 * Supports browser-level commands and session-multiplexed target commands
 * (via the sessionId parameter on send/events, using flatten: true).
 */
export class CDPSession {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private callbacks = new Map<number, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private listeners = new Map<string, Array<(params: Record<string, unknown>) => void>>();

  constructor(private wsUrl: string) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(new Error(`CDP WebSocket error: ${e}`));
      this.ws.onclose = () => {
        // Reject all pending callbacks
        for (const [, cb] of this.callbacks) {
          clearTimeout(cb.timer);
          cb.reject(new Error('CDP connection closed'));
        }
        this.callbacks.clear();
        // Fire close listeners
        for (const handler of this.listeners.get('close') ?? []) {
          handler({});
        }
      };
      this.ws.onmessage = (event) => {
        const msg = JSON.parse(
          typeof event.data === 'string' ? event.data : String(event.data),
        ) as Record<string, unknown>;

        // Handle command responses
        if (msg.id !== undefined && this.callbacks.has(msg.id as number)) {
          const cb = this.callbacks.get(msg.id as number)!;
          clearTimeout(cb.timer);
          this.callbacks.delete(msg.id as number);
          if (msg.error) {
            const err = msg.error as { message: string };
            cb.reject(new Error(`CDP: ${err.message}`));
          } else {
            cb.resolve(msg.result);
          }
        }

        // Handle events
        if (msg.method) {
          const sessionId = msg.sessionId as string | undefined;
          // Fire session-scoped handlers: "sessionId:Event.name"
          if (sessionId) {
            const scopedKey = `${sessionId}:${msg.method as string}`;
            for (const handler of this.listeners.get(scopedKey) ?? []) {
              handler(msg.params as Record<string, unknown>);
            }
          }
          // Fire global handlers (non-session-scoped)
          for (const handler of this.listeners.get(msg.method as string) ?? []) {
            handler({
              ...(msg.params as Record<string, unknown>),
              ...(sessionId ? { _sessionId: sessionId } : {}),
            });
          }
        }
      };
    });
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.callbacks.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 15000);
      this.callbacks.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      const msg: Record<string, unknown> = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      this.ws!.send(JSON.stringify(msg));
    });
  }

  on(event: string, handler: (params: Record<string, unknown>) => void): void {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)!.push(handler);
  }

  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

// ---- Attach engine ----

export interface AttachOptions {
  port: number;
  domainPatterns: string[];
  json: boolean;
  onProgress?: (line: string) => void;
}

export interface AttachResult {
  domains: Array<{
    domain: string;
    endpoints: number;
    skillFile: string;
  }>;
  totalRequests: number;
  filteredRequests: number;
  duration: number;
}

/**
 * Attach to a running Chrome instance via CDP, passively capture API traffic
 * across all tabs, and generate signed skill files on SIGINT.
 */
export async function attach(options: AttachOptions): Promise<AttachResult> {
  const { port, domainPatterns, json } = options;
  const log = (msg: string) => {
    if (!json) process.stderr.write(msg + '\n');
    options.onProgress?.(msg);
  };

  // SIGINT state — registered before any connection attempt (spec requirement)
  let stopping = false;

  // Phase 0: Discover browser
  let browserInfo;
  try {
    browserInfo = await discoverBrowserWsUrl(port);
  } catch {
    log(`[attach] Cannot connect to Chrome on :${port}`);
    log('');
    log('To enable remote debugging, relaunch Chrome with:');
    log(`  google-chrome --remote-debugging-port=${port}`);
    log('');
    log('Or on macOS:');
    log(`  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=${port}`);
    process.exit(1);
  }

  log(`[attach] Connected to ${browserInfo.browser} on :${port} (${browserInfo.tabCount} tabs)`);
  if (domainPatterns.length > 0) {
    log(`[attach] Watching domains: ${domainPatterns.join(', ')}`);
  } else {
    log('[attach] Watching all domains');
  }

  // Phase 1: Connect browser-level CDP session
  const browser = new CDPSession(browserInfo.wsUrl);
  await browser.connect();

  // Capture state
  const generators = new Map<string, SkillGenerator>();
  const requests = new Map<string, {
    url: string; method: string; headers: Record<string, string>; postData?: string;
  }>();
  const responses = new Map<string, {
    status: number; headers: Record<string, string>; mimeType: string;
  }>();
  let totalRequests = 0;
  let filteredRequests = 0;
  const startTime = Date.now();
  const activeSessions = new Set<string>();

  function enableNetworkForSession(sessionId: string): void {
    if (activeSessions.has(sessionId)) return;
    activeSessions.add(sessionId);

    // Prefix requestIds with sessionId to avoid collisions across tabs
    const prefix = sessionId.slice(0, 8);

    browser.on(`${sessionId}:Network.requestWillBeSent`, (params) => {
      const key = `${prefix}:${params.requestId}`;
      const request = params.request as Record<string, unknown>;
      requests.set(key, {
        url: request.url as string,
        method: request.method as string,
        headers: request.headers as Record<string, string>,
        postData: request.postData as string | undefined,
      });
    });

    browser.on(`${sessionId}:Network.responseReceived`, (params) => {
      const key = `${prefix}:${params.requestId}`;
      const response = params.response as Record<string, unknown>;
      responses.set(key, {
        status: response.status as number,
        headers: response.headers as Record<string, string>,
        mimeType: response.mimeType as string,
      });
    });

    browser.on(`${sessionId}:Network.loadingFinished`, (params) => {
      const key = `${prefix}:${params.requestId}`;
      const req = requests.get(key);
      const resp = responses.get(key);
      if (!req || !resp) return;

      totalRequests++;

      // Get response body immediately (before Chrome evicts it from buffer).
      // This MUST be called synchronously in the handler — deferring risks
      // "No resource with given identifier found" on high-traffic tabs.
      browser.send(
        'Network.getResponseBody',
        { requestId: params.requestId },
        sessionId,
      ).then((result) => {
        processExchange(key, req, resp, (result.body as string) ?? '', log);
      }).catch(() => {
        // Body evicted or unavailable — still process exchange without body
        processExchange(key, req, resp, '', log);
      });
    });

    // Enable network capture for this session (fire-and-forget)
    browser.send('Network.enable', {}, sessionId).catch(() => {
      // Session may have been destroyed
    });
  }

  function processExchange(
    key: string,
    req: { url: string; method: string; headers: Record<string, string>; postData?: string },
    resp: { status: number; headers: Record<string, string>; mimeType: string },
    body: string,
    logFn: (msg: string) => void,
  ): void {
    // Apply shouldCapture filter
    if (!shouldCapture({ url: req.url, status: resp.status, contentType: resp.mimeType })) {
      filteredRequests++;
      if (req.url.startsWith('chrome-extension://')) {
        logFn(`  [skip] ${req.url.slice(0, 50)}... (extension)`);
      }
      return;
    }

    // Apply domain glob filter
    let hostname: string;
    try {
      hostname = new URL(req.url).hostname;
    } catch { return; }

    if (!matchesDomainGlob(hostname, domainPatterns)) {
      filteredRequests++;
      return;
    }

    // Get or create generator for this domain
    if (!generators.has(hostname)) {
      generators.set(hostname, new SkillGenerator());
    }
    const gen = generators.get(hostname)!;

    const exchange: CapturedExchange = {
      request: {
        url: req.url,
        method: req.method,
        headers: req.headers,
        postData: req.postData,
      },
      response: {
        status: resp.status,
        headers: resp.headers,
        body,
        contentType: resp.mimeType,
      },
      timestamp: new Date().toISOString(),
    };

    const endpoint = gen.addExchange(exchange);
    if (endpoint) {
      logFn(`  [api] ${req.method} ${resp.status} ${hostname} ${endpoint.path}`);
    }

    // Clean up to avoid memory growth
    requests.delete(key);
    responses.delete(key);
  }

  // Phase 2: Attach to all existing page targets
  const { targetInfos } = await browser.send('Target.getTargets') as unknown as {
    targetInfos: Array<{ type: string; targetId: string }>;
  };
  for (const target of targetInfos) {
    if (target.type === 'page') {
      try {
        const result = await browser.send('Target.attachToTarget', {
          targetId: target.targetId,
          flatten: true,
        });
        enableNetworkForSession(result.sessionId as string);
      } catch {
        // Target may have navigated away
      }
    }
  }

  // Phase 3: Auto-attach to future targets (new tabs, popups, OAuth redirects).
  // flatten: true is critical — uses session-based CDP multiplexing instead
  // of legacy nested WebSocket connections.
  browser.on('Target.attachedToTarget', (params) => {
    const targetInfo = params.targetInfo as { type: string } | undefined;
    if (targetInfo?.type === 'page') {
      enableNetworkForSession(params.sessionId as string);
    }
  });

  await browser.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });

  // Phase 4: Wait for SIGINT or browser disconnect
  const result = await new Promise<AttachResult>((resolve) => {
    const shutdown = async () => {
      if (stopping) {
        // Second SIGINT — force exit immediately
        process.exit(1);
      }
      stopping = true;
      log('');

      const duration = Math.round((Date.now() - startTime) / 1000);

      if (generators.size === 0) {
        log('[attach] Nothing captured');
        browser.close();
        resolve({ domains: [], totalRequests, filteredRequests, duration });
        return;
      }

      log('[attach] Generating skill files...');

      const machineId = await getMachineId();
      const signingKey = deriveSigningKey(machineId);
      const apitapDir = process.env.APITAP_DIR || join(homedir(), '.apitap');
      const authManager = new AuthManager(apitapDir, machineId);
      const domains: AttachResult['domains'] = [];

      for (const [domain, gen] of generators) {
        let skill = gen.toSkillFile(domain);
        if (skill.endpoints.length === 0) continue;

        // Store extracted auth credentials — deduplicate by header name,
        // keeping the first (highest-priority) value for each header
        const extractedAuth = gen.getExtractedAuth();
        if (extractedAuth.length > 0) {
          const seen = new Set<string>();
          const uniqueHeaders: Array<{ header: string; value: string }> = [];
          for (const a of extractedAuth) {
            if (!seen.has(a.header)) {
              seen.add(a.header);
              uniqueHeaders.push({ header: a.header, value: a.value });
            }
          }
          const primary = extractedAuth[0];
          await authManager.store(domain, {
            type: primary.type,
            header: primary.header,
            value: primary.value,
            headers: uniqueHeaders,
          });
        }

        // Store OAuth credentials if detected
        const oauthConfig = gen.getOAuthConfig();
        if (oauthConfig) {
          const clientSecret = gen.getOAuthClientSecret();
          const refreshToken = gen.getOAuthRefreshToken();
          if (clientSecret || refreshToken) {
            await authManager.storeOAuthCredentials(domain, {
              ...(clientSecret ? { clientSecret } : {}),
              ...(refreshToken ? { refreshToken } : {}),
            });
          }
        }

        skill = signSkillFile(skill, signingKey);
        const skillPath = await writeSkillFile(skill);

        const displayPath = skillPath.replace(homedir(), '~');
        const count = skill.endpoints.length;
        log(`  ${domain} — ${count} endpoint${count === 1 ? '' : 's'} → ${displayPath}`);

        domains.push({ domain, endpoints: count, skillFile: displayPath });
      }

      browser.close();
      resolve({ domains, totalRequests, filteredRequests, duration });
    };

    process.on('SIGINT', shutdown);

    // Handle browser disconnect (user closed Chrome)
    browser.on('close', () => {
      if (!stopping) shutdown();
    });
  });

  return result;
}
