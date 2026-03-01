// src/capture/session.ts
import { type Browser, type Page } from 'playwright';
import { randomUUID } from 'node:crypto';
import { shouldCapture } from './filter.js';
import { launchBrowser, normalizeCookiesForStorageState } from './browser.js';
import { isDomainMatch } from './domain.js';
import { SkillGenerator, type GeneratorOptions } from '../skill/generator.js';
import { detectCaptcha } from '../auth/refresh.js';
import { verifyEndpoints } from './verifier.js';
import { signSkillFile } from '../skill/signing.js';
import { writeSkillFile } from '../skill/store.js';
import { AuthManager, getMachineId } from '../auth/manager.js';
import { deriveKey } from '../auth/crypto.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CapturedExchange, PageSnapshot, PageElement, InteractionResult, FinishResult } from '../types.js';

const APITAP_DIR = process.env.APITAP_DIR || join(homedir(), '.apitap');
const MAX_ELEMENTS = 100;
const MAX_TEXT_LENGTH = 200;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export interface SessionOptions {
  headless?: boolean;
  allDomains?: boolean;
  timeoutMs?: number;
  skillsDir?: string;
  authDir?: string;  // Base dir for auth storage (defaults to ~/.apitap)
}

export class CaptureSession {
  readonly id: string;
  private browser: Browser | null = null;
  private page: Page | null = null;
  private generators = new Map<string, SkillGenerator>();
  private totalRequests = 0;
  private filteredRequests = 0;
  private targetUrl = '';
  private options: SessionOptions;
  private captchaDetectedDomains = new Set<string>();
  private recentEndpoints: string[] = [];
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private expired = false;
  private closed = false;

  constructor(options: SessionOptions = {}) {
    this.id = randomUUID();
    this.options = options;
  }

  async start(url: string): Promise<PageSnapshot> {
    if (this.closed) throw new Error('Session already closed');

    this.targetUrl = url.startsWith('http') ? url : `https://${url}`;
    const headless = this.options.headless ?? true;

    // Load cached session cookies before launching browser
    let storageState: { cookies: any[]; origins: any[] } | undefined;
    try {
      const authDir = this.options.authDir ?? APITAP_DIR;
      const machineId = await getMachineId();
      const authManager = new AuthManager(authDir, machineId);
      const domain = new URL(this.targetUrl).hostname;
      const cachedSession = await authManager.retrieveSessionWithFallback(domain);
      if (cachedSession?.cookies?.length) {
        storageState = {
          cookies: normalizeCookiesForStorageState(cachedSession.cookies),
          origins: [],
        };
      }
    } catch {
      // Auth retrieval failed — proceed without cached session
    }

    const { browser, context } = await launchBrowser({ headless, storageState });
    this.browser = browser;

    this.page = await context.newPage();

    this.setupResponseListener();

    // Auto-timeout to prevent leaked browsers (resets on each interaction)
    this.resetTimeout();

    await this.page.goto(this.targetUrl, { waitUntil: 'domcontentloaded' });
    return this.takeSnapshot();
  }

  async interact(action: InteractionAction): Promise<InteractionResult> {
    if (this.expired) return { success: false, error: 'Session expired', snapshot: this.emptySnapshot() };
    if (this.closed) return { success: false, error: 'Session closed', snapshot: this.emptySnapshot() };
    if (!this.page) return { success: false, error: 'Session not started', snapshot: this.emptySnapshot() };

    // Reset timeout on each interaction — active sessions aren't leaked browsers
    this.resetTimeout();

    try {
      switch (action.action) {
        case 'snapshot':
          return { success: true, snapshot: await this.takeSnapshot() };

        case 'click': {
          if (!action.ref) return { success: false, error: 'ref required for click', snapshot: await this.takeSnapshot() };
          const el = await this.resolveRef(action.ref);
          if (!el) return { success: false, error: `Element ${action.ref} not found`, snapshot: await this.takeSnapshot() };
          await el.click();
          await this.page.waitForLoadState('domcontentloaded').catch(() => {});
          return { success: true, snapshot: await this.takeSnapshot() };
        }

        case 'type': {
          if (!action.ref) return { success: false, error: 'ref required for type', snapshot: await this.takeSnapshot() };
          if (action.text === undefined) return { success: false, error: 'text required for type', snapshot: await this.takeSnapshot() };
          const el = await this.resolveRef(action.ref);
          if (!el) return { success: false, error: `Element ${action.ref} not found`, snapshot: await this.takeSnapshot() };
          await el.fill(action.text);
          if (action.submit) {
            await el.press('Enter');
            await this.page.waitForLoadState('domcontentloaded').catch(() => {});
          }
          return { success: true, snapshot: await this.takeSnapshot() };
        }

        case 'select': {
          if (!action.ref) return { success: false, error: 'ref required for select', snapshot: await this.takeSnapshot() };
          if (action.value === undefined) return { success: false, error: 'value required for select', snapshot: await this.takeSnapshot() };
          const el = await this.resolveRef(action.ref);
          if (!el) return { success: false, error: `Element ${action.ref} not found`, snapshot: await this.takeSnapshot() };
          await el.selectOption(action.value);
          return { success: true, snapshot: await this.takeSnapshot() };
        }

        case 'navigate': {
          if (!action.url) return { success: false, error: 'url required for navigate', snapshot: await this.takeSnapshot() };

          // Basic URL validation — block non-HTTP schemes and cloud metadata
          let parsed: URL;
          try { parsed = new URL(action.url); } catch {
            return { success: false, error: 'Invalid URL', snapshot: await this.takeSnapshot() };
          }

          // Block non-HTTP schemes (file://, ftp://, etc.)
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return { success: false, error: `Blocked scheme: ${parsed.protocol}`, snapshot: await this.takeSnapshot() };
          }

          // Block cloud metadata endpoint specifically (high-value target)
          if (parsed.hostname === '169.254.169.254') {
            return { success: false, error: 'Navigation blocked: cloud metadata endpoint', snapshot: await this.takeSnapshot() };
          }

          await this.page.goto(action.url, { waitUntil: 'domcontentloaded' });
          return { success: true, snapshot: await this.takeSnapshot() };
        }

        case 'scroll': {
          const dir = action.direction ?? 'down';
          const delta = dir === 'up' ? -500 : 500;
          await this.page.mouse.wheel(0, delta);
          // Wait a bit for lazy-loaded content
          await this.page.waitForTimeout(500);
          return { success: true, snapshot: await this.takeSnapshot() };
        }

        case 'wait': {
          const seconds = Math.min(action.seconds ?? 2, 10);
          await this.page.waitForTimeout(seconds * 1000);
          return { success: true, snapshot: await this.takeSnapshot() };
        }

        default:
          return { success: false, error: `Unknown action: ${(action as any).action}`, snapshot: await this.takeSnapshot() };
      }
    } catch (err: any) {
      // Try to return snapshot even on error
      try {
        return { success: false, error: err.message, snapshot: await this.takeSnapshot() };
      } catch {
        return { success: false, error: err.message, snapshot: this.emptySnapshot() };
      }
    }
  }

  async finish(): Promise<FinishResult> {
    if (this.closed) return { aborted: true, domains: [] };

    // Measure DOM size before closing
    let domBytes: number | undefined;
    if (this.page) {
      try {
        const html = await this.page.content();
        domBytes = html.length;
      } catch { /* page may have navigated away */ }
    }

    await this.cleanup();

    // Mark captcha risk
    for (const [hostname, gen] of this.generators) {
      if (this.captchaDetectedDomains.has(hostname)) {
        gen.setCaptchaRisk(true);
      }
    }

    // Finalize: generate skill files, verify, sign, write
    const machineId = await getMachineId();
    const key = deriveKey(machineId);
    const authManager = new AuthManager(APITAP_DIR, machineId);

    const domains: FinishResult['domains'] = [];

    for (const [domain, generator] of this.generators) {
      let skill = generator.toSkillFile(domain, {
        domBytes,
        totalRequests: this.totalRequests,
      });

      if (skill.endpoints.length === 0) continue;

      // Store extracted auth
      const extractedAuth = generator.getExtractedAuth();
      if (extractedAuth.length > 0) {
        await authManager.store(domain, extractedAuth[0]);
      }

      // Store OAuth credentials if detected
      const oauthConfig = generator.getOAuthConfig();
      if (oauthConfig) {
        const clientSecret = generator.getOAuthClientSecret();
        const refreshToken = generator.getOAuthRefreshToken();
        if (clientSecret || refreshToken) {
          await authManager.storeOAuthCredentials(domain, {
            ...(clientSecret ? { clientSecret } : {}),
            ...(refreshToken ? { refreshToken } : {}),
          });
        }
      }

      // Verify endpoints
      skill = await verifyEndpoints(skill);

      // Sign
      skill = signSkillFile(skill, key);

      // Write
      const skillsDir = this.options.skillsDir;
      const path = await writeSkillFile(skill, skillsDir);

      // Tally tiers
      const tiers: Record<string, number> = {};
      for (const ep of skill.endpoints) {
        const t = ep.replayability?.tier ?? 'unknown';
        tiers[t] = (tiers[t] ?? 0) + 1;
      }

      domains.push({
        domain,
        endpointCount: skill.endpoints.length,
        tiers,
        skillFile: path,
      });
    }

    return { aborted: false, domains };
  }

  async abort(): Promise<void> {
    await this.cleanup();
  }

  /** Whether session has been terminated (expired, closed, or aborted) */
  get isActive(): boolean {
    return !this.closed && !this.expired;
  }

  // --- private ---

  private setupResponseListener(): void {
    if (!this.page) return;

    const generatorOptions: GeneratorOptions = {
      enablePreview: false,
      scrub: true,
    };

    this.page.on('response', async (response) => {
      this.totalRequests++;

      const url = response.url();
      const status = response.status();
      const contentType = response.headers()['content-type'] ?? '';

      // Domain filtering
      if (!this.options.allDomains) {
        const hostname = safeHostname(url);
        if (hostname && !isDomainMatch(hostname, this.targetUrl)) {
          this.filteredRequests++;
          return;
        }
      }

      if (!shouldCapture({ url, status, contentType })) {
        this.filteredRequests++;
        const hostname = safeHostname(url);
        if (hostname) {
          const gen = this.generators.get(hostname);
          if (gen) gen.recordFiltered();
        }
        // Track network bytes
        const contentLength = parseInt(response.headers()['content-length'] ?? '0', 10);
        if (contentLength > 0) {
          const filteredHostname = safeHostname(url);
          if (filteredHostname && this.generators.has(filteredHostname)) {
            this.generators.get(filteredHostname)!.addNetworkBytes(contentLength);
          }
        }
        return;
      }

      try {
        const body = await response.text();
        const hostname = new URL(url).hostname;

        // Captcha detection
        if (contentType.includes('text/html') && detectCaptcha(body)) {
          this.captchaDetectedDomains.add(hostname);
        }

        if (!this.generators.has(hostname)) {
          this.generators.set(hostname, new SkillGenerator(generatorOptions));
        }
        const gen = this.generators.get(hostname)!;

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
          const label = `${endpoint.method} ${endpoint.path}`;
          this.recentEndpoints.push(label);
          if (this.recentEndpoints.length > 5) {
            this.recentEndpoints.shift();
          }
        }
      } catch {
        // Response body may not be available
      }
    });
  }

  private async takeSnapshot(): Promise<PageSnapshot> {
    if (!this.page) return this.emptySnapshot();

    try {
      const url = this.page.url();
      const title = await this.page.title();
      const elements = await this.extractElements();

      // Count unique endpoints across all generators
      let endpointsCaptured = 0;
      for (const gen of this.generators.values()) {
        endpointsCaptured += gen.endpointCount;
      }

      return {
        url,
        title,
        elements,
        endpointsCaptured,
        totalRequests: this.totalRequests,
        filteredRequests: this.filteredRequests,
        recentEndpoints: [...this.recentEndpoints],
      };
    } catch {
      return this.emptySnapshot();
    }
  }

  private async extractElements(): Promise<PageElement[]> {
    if (!this.page) return [];

    return this.page.evaluate(({ maxElements, maxText }) => {
      const selector = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [onclick], [tabindex]';
      const nodes = document.querySelectorAll(selector);
      const results: PageElement[] = [];

      for (const node of nodes) {
        if (results.length >= maxElements) break;

        const el = node as HTMLElement;
        // Skip hidden/tiny elements
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;

        const tag = el.tagName.toLowerCase();
        const text = (el.textContent || '').trim().slice(0, maxText);
        const role = el.getAttribute('role') || undefined;
        const name = (el as HTMLInputElement).name || undefined;
        const placeholder = (el as HTMLInputElement).placeholder || undefined;
        const href = (el as HTMLAnchorElement).href || undefined;
        const type = (el as HTMLInputElement).type || undefined;
        const disabled = (el as HTMLInputElement).disabled || undefined;

        results.push({
          ref: `e${results.length}`,
          tag,
          ...(role ? { role } : {}),
          text,
          ...(name ? { name } : {}),
          ...(placeholder ? { placeholder } : {}),
          ...(href ? { href } : {}),
          ...(type ? { type } : {}),
          ...(disabled ? { disabled } : {}),
        });
      }

      return results;
    }, { maxElements: MAX_ELEMENTS, maxText: MAX_TEXT_LENGTH });
  }

  private async resolveRef(ref: string): Promise<ReturnType<Page['locator']> | null> {
    if (!this.page) return null;

    const index = parseInt(ref.replace('e', ''), 10);
    if (isNaN(index)) return null;

    // Re-query the DOM to get the nth visible interactive element
    const selector = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [onclick], [tabindex]';
    const elements = await this.page.$$(selector);

    // Filter to visible elements
    let visibleIndex = 0;
    for (const el of elements) {
      const visible = await el.isVisible().catch(() => false);
      if (!visible) continue;

      if (visibleIndex === index) {
        return el as any;
      }
      visibleIndex++;
    }

    return null;
  }

  private emptySnapshot(): PageSnapshot {
    return {
      url: '',
      title: '',
      elements: [],
      endpointsCaptured: 0,
      totalRequests: this.totalRequests,
      filteredRequests: this.filteredRequests,
      recentEndpoints: [...this.recentEndpoints],
    };
  }

  /** Reset the auto-timeout timer (called on each interaction to prevent premature close) */
  private resetTimeout(): void {
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.timeoutTimer = setTimeout(() => {
      this.expired = true;
      this.cleanup().catch(() => {});
    }, timeoutMs);
    if (this.timeoutTimer.unref) this.timeoutTimer.unref();
  }

  private async cleanup(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }

    if (this.browser) {
      try {
        await this.browser.close();
      } catch { /* already closed */ }
      this.browser = null;
      this.page = null;
    }
  }
}

export interface InteractionAction {
  action: 'snapshot' | 'click' | 'type' | 'select' | 'navigate' | 'scroll' | 'wait';
  ref?: string;
  text?: string;
  value?: string;
  url?: string;
  direction?: 'up' | 'down';
  seconds?: number;
  submit?: boolean;
}

function safeHostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
