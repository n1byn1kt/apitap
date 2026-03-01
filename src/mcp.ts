#!/usr/bin/env node
// src/mcp.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { searchSkills } from './skill/search.js';
import { readSkillFile } from './skill/store.js';
import { replayEndpoint } from './replay/engine.js';
import { AuthManager, getMachineId } from './auth/manager.js';
import { requestAuth } from './auth/handoff.js';
import { CaptureSession } from './capture/session.js';
import { discover } from './discovery/index.js';
import { SessionCache } from './orchestration/cache.js';
import { peek } from './read/peek.js';
import { read } from './read/index.js';
import { resolveAndValidateUrl } from './skill/ssrf.js';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APITAP_DIR = join(homedir(), '.apitap');
const require = createRequire(import.meta.url);
const { version: PACKAGE_VERSION } = require('../package.json') as { version: string };

/**
 * Wrap response data with external content metadata.
 * MCP clients that respect this can apply security wrappers (e.g., SECURITY NOTICE).
 * Tier classification is about replay success, not content trustworthiness —
 * all external API data should be marked as untrusted.
 */
function wrapExternalContent(data: unknown, source: string) {
  return {
    content: [{ 
      type: 'text' as const, 
      text: JSON.stringify(data),
    }],
    // MCP extension: mark as external untrusted content
    _meta: {
      externalContent: {
        untrusted: true,
        source,
      },
    },
  };
}

export interface McpServerOptions {
  skillsDir?: string;
  /** @internal Skip SSRF check in replay — for testing only */
  _skipSsrfCheck?: boolean;
}

const MAX_SESSIONS = 3;

export function createMcpServer(options: McpServerOptions = {}): McpServer {
  const skillsDir = options.skillsDir;
  const sessions = new Map<string, CaptureSession>();
  const sessionCache = new SessionCache();

  const server = new McpServer({
    name: 'apitap',
    version: PACKAGE_VERSION,
  });

  // --- apitap_search ---
  server.registerTool(
    'apitap_search',
    {
      description:
        'Find captured API endpoints by domain or keyword. ' +
        'Returns endpoints with replayability tier (green/yellow/orange/red) and endpoint IDs for replay.',
      inputSchema: z.object({
        query: z.string().describe('Search query — domain name, endpoint path, or keyword (e.g. "polymarket", "events", "get-markets")'),
      }),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ query }) => {
      const result = await searchSkills(query, skillsDir);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    },
  );

  // --- apitap_discover ---
  server.registerTool(
    'apitap_discover',
    {
      description:
        'Probe a site\'s APIs without a browser: detects frameworks, finds OpenAPI specs, ' +
        'probes common paths. Returns { confidence, skillFile?, frameworks?, hints }. ' +
        'High/medium confidence generates a skeleton skill file ready to replay.',
      inputSchema: z.object({
        url: z.string().describe('URL to discover (e.g. "https://example.com")'),
      }),
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ url }) => {
      try {
        const result = await discover(url);

        // If we got a skill file, save it automatically
        if (result.skillFile && (result.confidence === 'high' || result.confidence === 'medium')) {
          const { writeSkillFile } = await import('./skill/store.js');
          const path = await writeSkillFile(result.skillFile, skillsDir);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ ...result, savedTo: path }) }],
          };
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: `Discovery failed: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  // --- apitap_replay ---
  server.registerTool(
    'apitap_replay',
    {
      description:
        'Call a captured API endpoint and return live data. ' +
        'Requires domain and endpointId from apitap_search. ' +
        'Pass params for path variables, query params, or body variables (e.g. "variables.limit": "25" for GraphQL).',
      inputSchema: z.object({
        domain: z.string().describe('Domain of the API (e.g. "gamma-api.polymarket.com")'),
        endpointId: z.string().describe('Endpoint ID from search results (e.g. "get-events", "post-graphql-GetPosts")'),
        params: z.object({}).passthrough().optional().describe('Optional key-value parameters: path params (id), query params, or body variables (variables.limit for GraphQL)'),
        fresh: z.boolean().optional().describe('Force token refresh before replay (opens browser to capture fresh CSRF/session tokens)'),
        maxBytes: z.number().optional().describe('Maximum response size in bytes. Large responses are truncated to fit. Omit for unlimited.'),
      }),
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ domain, endpointId, params, fresh, maxBytes }) => {
      const skill = await readSkillFile(domain, skillsDir);
      if (!skill) {
        return {
          content: [{ type: 'text' as const, text: `No skill file found for "${domain}". Use apitap_capture to capture it first.` }],
          isError: true,
        };
      }

      const endpoint = skill.endpoints.find(e => e.id === endpointId);
      if (!endpoint) {
        return {
          content: [{ type: 'text' as const, text: `Endpoint "${endpointId}" not found. Available: ${skill.endpoints.map(e => e.id).join(', ')}` }],
          isError: true,
        };
      }

      // Get auth manager for token injection and header auth
      const machineId = await getMachineId();
      const authManager = new AuthManager(APITAP_DIR, machineId);

      // Inject stored header auth if needed
      const hasStoredPlaceholder = Object.values(endpoint.headers).some(v => v === '[stored]');
      if (hasStoredPlaceholder) {
        try {
          const storedAuth = await authManager.retrieve(domain);
          if (storedAuth) {
            endpoint.headers[storedAuth.header] = storedAuth.value;
          }
        } catch {
          // Auth retrieval failed — proceed without it
        }
      }

      try {
        const result = await replayEndpoint(skill, endpointId, {
          params: params as Record<string, string> | undefined,
          authManager,
          domain,
          fresh: fresh ?? false,
          maxBytes,
          _skipSsrfCheck: options._skipSsrfCheck,
        });
        const cached = sessionCache.get(domain);
        const fromCache = !cached || cached.source === 'disk';

        return wrapExternalContent({
            status: result.status,
            data: result.data,
            domain,
            endpointId,
            tier: endpoint.replayability?.tier ?? 'unknown',
            fromCache,
            capturedAt: skill.capturedAt,
            ...(result.refreshed ? { refreshed: result.refreshed } : {}),
            ...(result.truncated ? { truncated: true } : {}),
          }, 'apitap_replay');
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: `Replay failed: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  // --- apitap_replay_batch ---
  server.registerTool(
    'apitap_replay_batch',
    {
      description:
        'Replay multiple captured endpoints in parallel across domains. ' +
        'Returns array of { domain, endpointId, status, data, error? } — failures are isolated per request.',
      inputSchema: z.object({
        requests: z.array(z.object({
          domain: z.string().describe('Domain of the API'),
          endpointId: z.string().describe('Endpoint ID from search results'),
          params: z.object({}).passthrough().optional().describe('Optional key-value parameters'),
        })).describe('Array of replay requests to execute in parallel'),
        maxBytes: z.number().optional().describe('Maximum response size in bytes per result. Large responses are truncated to fit.'),
      }),
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ requests, maxBytes }) => {
      const { replayMultiple } = await import('./replay/engine.js');
      const typed = requests.map(r => ({
        domain: r.domain,
        endpointId: r.endpointId,
        params: r.params as Record<string, string> | undefined,
      }));
      const results = await replayMultiple(typed, { skillsDir, maxBytes, _skipSsrfCheck: options._skipSsrfCheck });
      return wrapExternalContent(results, 'apitap_replay_batch');
    },
  );

  // --- apitap_browse ---
  server.registerTool(
    'apitap_browse',
    {
      description:
        'Get data from a URL in one call: checks skill files, runs discovery, replays best endpoint. ' +
        'Returns { success, data, domain, endpointId, tier } or { success: false, suggestion } if capture needed.',
      inputSchema: z.object({
        url: z.string().describe('URL to browse (e.g. "https://zillow.com/rentals/portland")'),
        task: z.string().optional().describe('Optional task description (e.g. "find apartments under $1500") — passed through in response for correlation'),
        maxBytes: z.number().optional().describe('Maximum response size in bytes (default: 50000). Large responses are truncated to fit.'),
      }),
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ url, task, maxBytes }) => {
      const { browse: doBrowse } = await import('./orchestration/browse.js');
      const result = await doBrowse(url, {
        skillsDir,
        cache: sessionCache,
        task,
        maxBytes: maxBytes ?? 50_000,
        _skipSsrfCheck: options._skipSsrfCheck,
      });
      // Only mark as untrusted if it contains external data
      if (result.success && result.data) {
        return wrapExternalContent(result, 'apitap_browse');
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    },
  );

  // --- apitap_peek ---
  server.registerTool(
    'apitap_peek',
    {
      description:
        'HTTP HEAD triage of a URL — checks accessibility, bot protection, framework. ' +
        'Returns { accessible, recommendation, botProtection, framework }.',
      inputSchema: z.object({
        url: z.string().describe('URL to peek at (e.g. "https://example.com")'),
      }),
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ url }) => {
      try {
        const result = await peek(url);
        // Peek returns metadata, not content — but still from external source
        return wrapExternalContent(result, 'apitap_peek');
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: `Peek failed: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  // --- apitap_read ---
  server.registerTool(
    'apitap_read',
    {
      description:
        'Extract content from a URL without a browser. Uses native APIs for Reddit/YouTube/Wikipedia/HN, ' +
        'HTML extraction elsewhere. Returns clean markdown. ~10K tokens vs 200K for browser.',
      inputSchema: z.object({
        url: z.string().describe('URL to read (e.g. "https://en.wikipedia.org/wiki/TypeScript")'),
        maxBytes: z.number().optional().describe('Maximum content size in bytes. Content is truncated to fit.'),
      }),
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ url, maxBytes }) => {
      try {
        const validation = await resolveAndValidateUrl(url);
        if (!validation.safe) {
          throw new Error(validation.reason ?? 'URL validation failed');
        }
        const result = await read(url, { maxBytes: maxBytes ?? undefined });
        if (!result) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Failed to read content', url }) }],
            isError: true,
          };
        }
        return wrapExternalContent(result, 'apitap_read');
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: `Read failed: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  // --- apitap_capture ---
  server.registerTool(
    'apitap_capture',
    {
      description:
        'Launch a browser to capture a site\'s API traffic and save skill files for replay. ' +
        'Returns { domains, totalRequests, skillFiles }.',
      inputSchema: z.object({
        url: z.string().describe('URL to capture (e.g. "https://polymarket.com")'),
        duration: z.number().optional().describe('Capture duration in seconds (default: 30)'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ url, duration }) => {
      const dur = duration ?? 30;
      const timeoutMs = (dur + 60) * 1000; // generous timeout: capture duration + 60s for start/finish

      const session = new CaptureSession({
        headless: true,
        allDomains: false,
        skillsDir,
      });

      try {
        const result = await Promise.race([
          (async () => {
            await session.start(url);
            await new Promise(resolve => setTimeout(resolve, dur * 1000));
            return session.finish();
          })(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Capture timed out')), timeoutMs),
          ),
        ]);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      } catch (err: any) {
        try { await session.abort(); } catch { /* already closed */ }
        return {
          content: [{ type: 'text' as const, text: `Capture failed: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  // --- apitap_capture_start ---
  server.registerTool(
    'apitap_capture_start',
    {
      description:
        'Start an interactive capture session. Launches browser, begins capturing API traffic. ' +
        'Returns sessionId and page snapshot. Drive with apitap_capture_interact, save with apitap_capture_finish.',
      inputSchema: z.object({
        url: z.string().describe('URL to navigate to (e.g. "https://polymarket.com")'),
        headless: z.boolean().optional().describe('Run browser in headless mode (default: true)'),
        allDomains: z.boolean().optional().describe('Capture traffic from all domains, not just the target (default: false)'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ url, headless, allDomains }) => {
      if (sessions.size >= MAX_SESSIONS) {
        return {
          content: [{ type: 'text' as const, text: `Maximum ${MAX_SESSIONS} concurrent sessions. Finish or abort an existing session first.` }],
          isError: true,
        };
      }

      try {
        const session = new CaptureSession({
          headless: headless ?? true,
          allDomains: allDomains ?? false,
          skillsDir,
        });
        const snapshot = await session.start(url);
        sessions.set(session.id, session);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ sessionId: session.id, snapshot }) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: `Failed to start capture session: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  // --- apitap_capture_interact ---
  server.registerTool(
    'apitap_capture_interact',
    {
      description:
        'Drive a live capture session browser. ' +
        'Actions: snapshot, click (ref), type (ref+text), select, navigate, scroll, wait. ' +
        'Returns updated page snapshot after each action. Use element refs (e.g. "e0") from snapshots.',
      inputSchema: z.object({
        sessionId: z.string().describe('Session ID from apitap_capture_start'),
        action: z.enum(['snapshot', 'click', 'type', 'select', 'navigate', 'scroll', 'wait']).describe('Action to perform'),
        ref: z.string().optional().describe('Element ref from snapshot (e.g. "e0") — required for click, type, select'),
        text: z.string().optional().describe('Text to type — required for type action'),
        value: z.string().optional().describe('Option value — required for select action'),
        url: z.string().optional().describe('URL — required for navigate action'),
        direction: z.enum(['up', 'down']).optional().describe('Scroll direction (default: down)'),
        seconds: z.number().optional().describe('Seconds to wait (max 10) — for wait action'),
        submit: z.boolean().optional().describe('Press Enter after typing (default: false)'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ sessionId, action, ref, text, value, url, direction, seconds, submit }) => {
      const session = sessions.get(sessionId);
      if (!session) {
        // Clean up expired sessions
        for (const [id, s] of sessions) {
          if (!s.isActive) sessions.delete(id);
        }
        return {
          content: [{ type: 'text' as const, text: `Session "${sessionId}" not found or expired.` }],
          isError: true,
        };
      }

      const result = await session.interact({
        action: action as any,
        ref,
        text,
        value,
        url,
        direction: direction as 'up' | 'down' | undefined,
        seconds,
        submit,
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        ...(result.success ? {} : { isError: true }),
      };
    },
  );

  // --- apitap_capture_finish ---
  server.registerTool(
    'apitap_capture_finish',
    {
      description:
        'Finish a capture session: verifies endpoints and writes skill files. ' +
        'Pass abort:true to close without saving. Returns { aborted, domains }.',
      inputSchema: z.object({
        sessionId: z.string().describe('Session ID from apitap_capture_start'),
        abort: z.boolean().optional().describe('Abort without saving (default: false)'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ sessionId, abort: shouldAbort }) => {
      const session = sessions.get(sessionId);
      if (!session) {
        // Clean up expired sessions
        for (const [id, s] of sessions) {
          if (!s.isActive) sessions.delete(id);
        }
        return {
          content: [{ type: 'text' as const, text: `Session "${sessionId}" not found or expired.` }],
          isError: true,
        };
      }

      sessions.delete(sessionId);

      try {
        if (shouldAbort) {
          await session.abort();
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ aborted: true, domains: [] }) }],
          };
        }

        const result = await session.finish();
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: `Finish failed: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  // --- apitap_auth_request ---
  server.registerTool(
    'apitap_auth_request',
    {
      description:
        'Open a visible browser for human login (handles 2FA, CAPTCHAs). ' +
        'The user must CLOSE THE BROWSER WINDOW when they are done logging in — ' +
        'this is the signal that authentication is complete. ' +
        'Tell the user to close the browser after login. ' +
        'Stores session tokens encrypted — auto-injected on future replay/capture calls.',
      inputSchema: z.object({
        domain: z.string().describe('Domain to authenticate (e.g. "github.com")'),
        loginUrl: z.string().optional().describe('Login page URL (defaults to https://<domain>)'),
        timeout: z.number().optional().describe('Timeout in seconds for human to complete login (default: 300)'),
      }),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
      },
    },
    async ({ domain, loginUrl, timeout }) => {
      const machineId = await getMachineId();
      const authManager = new AuthManager(APITAP_DIR, machineId);

      try {
        const result = await requestAuth(authManager, {
          domain,
          loginUrl,
          timeout: timeout ? timeout * 1000 : undefined,
        });

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          ...(result.success ? {} : { isError: true }),
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: `Auth request failed: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}

// --- stdio entry point ---
// Only start when run directly (not imported for testing)
// Normalize backslashes for Windows compatibility
const _argv1 = (process.argv[1] || '').replace(/\\/g, '/');
const isMainModule = _argv1.endsWith('/mcp.ts') ||
  _argv1.endsWith('/mcp.js') ||
  _argv1.endsWith('/apitap-mcp');

if (isMainModule) {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  server.connect(transport).catch((err) => {
    console.error('MCP server failed to start:', err);
    process.exit(1);
  });
}
