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
import { homedir } from 'node:os';
import { join } from 'node:path';
const APITAP_DIR = join(homedir(), '.apitap');
const MAX_SESSIONS = 3;
export function createMcpServer(options = {}) {
    const skillsDir = options.skillsDir;
    const sessions = new Map();
    const sessionCache = new SessionCache();
    const server = new McpServer({
        name: 'apitap',
        version: '0.5.0',
    });
    // --- apitap_search ---
    server.registerTool('apitap_search', {
        description: 'Search available API skill files for a domain or endpoint. ' +
            'Use this FIRST to check if ApiTap has captured a site\'s API before trying to replay. ' +
            'Returns matching endpoints with replayability tiers: ' +
            'green = public, no auth needed — safe to replay directly; ' +
            'yellow = needs auth credentials but no signing/anti-bot; ' +
            'orange = CSRF/session-bound, fragile replay; ' +
            'red = anti-bot protection, needs browser. ' +
            'If not found, use apitap_capture to capture the site first.',
        inputSchema: z.object({
            query: z.string().describe('Search query — domain name, endpoint path, or keyword (e.g. "polymarket", "events", "get-markets")'),
        }),
        annotations: {
            readOnlyHint: true,
            openWorldHint: false,
        },
    }, async ({ query }) => {
        const result = await searchSkills(query, skillsDir);
        return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
        };
    });
    // --- apitap_discover ---
    server.registerTool('apitap_discover', {
        description: 'Discover a site\'s APIs without launching a browser. ' +
            'Detects frameworks (WordPress, Shopify, Next.js, GraphQL), ' +
            'finds OpenAPI/Swagger specs, and probes common API paths. ' +
            'Use this BEFORE apitap_capture to check if expensive browser-based capture is needed. ' +
            'Returns { confidence, skillFile?, hints, frameworks?, specs?, probes? }. ' +
            'If confidence is "high" or "medium", a skeleton skill file is generated — ' +
            'try replaying its endpoints before resorting to capture.',
        inputSchema: z.object({
            url: z.string().describe('URL to discover (e.g. "https://example.com")'),
        }),
        annotations: {
            readOnlyHint: true,
            openWorldHint: true,
        },
    }, async ({ url }) => {
        try {
            const result = await discover(url);
            // If we got a skill file, save it automatically
            if (result.skillFile && (result.confidence === 'high' || result.confidence === 'medium')) {
                const { writeSkillFile } = await import('./skill/store.js');
                const path = await writeSkillFile(result.skillFile, skillsDir);
                return {
                    content: [{ type: 'text', text: JSON.stringify({ ...result, savedTo: path }) }],
                };
            }
            return {
                content: [{ type: 'text', text: JSON.stringify(result) }],
            };
        }
        catch (err) {
            return {
                content: [{ type: 'text', text: `Discovery failed: ${err.message}` }],
                isError: true,
            };
        }
    });
    // --- apitap_replay ---
    server.registerTool('apitap_replay', {
        description: 'Replay a captured API endpoint to get live data without a browser. ' +
            'Check the endpoint tier first with apitap_search: ' +
            'green = will work, yellow = needs auth, orange/red = may fail. ' +
            'For POST endpoints with request bodies, params can include body variable paths ' +
            '(e.g. "variables.limit": "25" for GraphQL). ' +
            'Returns { status, data } with the API response.',
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
    }, async ({ domain, endpointId, params, fresh, maxBytes }) => {
        const skill = await readSkillFile(domain, skillsDir);
        if (!skill) {
            return {
                content: [{ type: 'text', text: `No skill file found for "${domain}". Use apitap_capture to capture it first.` }],
                isError: true,
            };
        }
        const endpoint = skill.endpoints.find(e => e.id === endpointId);
        if (!endpoint) {
            return {
                content: [{ type: 'text', text: `Endpoint "${endpointId}" not found. Available: ${skill.endpoints.map(e => e.id).join(', ')}` }],
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
            }
            catch {
                // Auth retrieval failed — proceed without it
            }
        }
        try {
            const result = await replayEndpoint(skill, endpointId, {
                params: params,
                authManager,
                domain,
                fresh: fresh ?? false,
                maxBytes,
                _skipSsrfCheck: options._skipSsrfCheck,
            });
            const cached = sessionCache.get(domain);
            const fromCache = !cached || cached.source === 'disk';
            return {
                content: [{ type: 'text', text: JSON.stringify({
                            status: result.status,
                            data: result.data,
                            domain,
                            endpointId,
                            tier: endpoint.replayability?.tier ?? 'unknown',
                            fromCache,
                            capturedAt: skill.capturedAt,
                            ...(result.refreshed ? { refreshed: result.refreshed } : {}),
                            ...(result.truncated ? { truncated: true } : {}),
                        }) }],
            };
        }
        catch (err) {
            return {
                content: [{ type: 'text', text: `Replay failed: ${err.message}` }],
                isError: true,
            };
        }
    });
    // --- apitap_replay_batch ---
    server.registerTool('apitap_replay_batch', {
        description: 'Replay multiple API endpoints in parallel across different domains. ' +
            'Use this when you need data from several sites at once (e.g. comparing prices across stores). ' +
            'Each request gets its own result — one site failing does not affect others. ' +
            'Returns an array of { domain, endpointId, status, data, error?, tier?, capturedAt? }.',
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
    }, async ({ requests, maxBytes }) => {
        const { replayMultiple } = await import('./replay/engine.js');
        const typed = requests.map(r => ({
            domain: r.domain,
            endpointId: r.endpointId,
            params: r.params,
        }));
        const results = await replayMultiple(typed, { skillsDir, maxBytes, _skipSsrfCheck: options._skipSsrfCheck });
        return {
            content: [{ type: 'text', text: JSON.stringify(results) }],
        };
    });
    // --- apitap_browse ---
    server.registerTool('apitap_browse', {
        description: 'High-level "just get me the data" tool. ' +
            'Checks if a skill file exists for the site, runs discovery if needed, ' +
            'and replays the best matching endpoint — all in one call. ' +
            'Use this when you want data from a URL without manually chaining search → discover → replay. ' +
            'Returns { success: true, data, domain, endpointId, tier } on success, ' +
            'or { success: false, suggestion: "capture_needed" } if the site needs browser-based capture first. ' +
            'For precise control over which endpoint to replay, use apitap_search + apitap_replay instead.',
        inputSchema: z.object({
            url: z.string().describe('URL to browse (e.g. "https://zillow.com/rentals/portland")'),
            task: z.string().optional().describe('Optional task description (e.g. "find apartments under $1500") — passed through in response for correlation'),
            maxBytes: z.number().optional().describe('Maximum response size in bytes (default: 50000). Large responses are truncated to fit.'),
        }),
        annotations: {
            readOnlyHint: true,
            openWorldHint: true,
        },
    }, async ({ url, task, maxBytes }) => {
        const { browse: doBrowse } = await import('./orchestration/browse.js');
        const result = await doBrowse(url, {
            skillsDir,
            cache: sessionCache,
            task,
            maxBytes: maxBytes ?? 50_000,
            _skipSsrfCheck: options._skipSsrfCheck,
        });
        return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
        };
    });
    // --- apitap_peek ---
    server.registerTool('apitap_peek', {
        description: 'Zero-cost triage of a URL. HTTP HEAD only -- checks accessibility, ' +
            'bot protection, framework detection. Use before apitap_read to avoid wasting ' +
            'tokens on blocked sites. Returns { accessible, recommendation, botProtection, framework, signals }.',
        inputSchema: z.object({
            url: z.string().describe('URL to peek at (e.g. "https://example.com")'),
        }),
        annotations: {
            readOnlyHint: true,
            openWorldHint: true,
        },
    }, async ({ url }) => {
        try {
            const result = await peek(url);
            return {
                content: [{ type: 'text', text: JSON.stringify(result) }],
            };
        }
        catch (err) {
            return {
                content: [{ type: 'text', text: `Peek failed: ${err.message}` }],
                isError: true,
            };
        }
    });
    // --- apitap_read ---
    server.registerTool('apitap_read', {
        description: 'Extract content from a URL without a browser. Uses side-channel APIs ' +
            'for known sites (Reddit, YouTube, Wikipedia, HN) and HTML content extraction for ' +
            'everything else. Returns structured JSON with clean markdown content. 0-10K tokens ' +
            'vs 50-200K for browser automation.',
        inputSchema: z.object({
            url: z.string().describe('URL to read (e.g. "https://en.wikipedia.org/wiki/TypeScript")'),
            maxBytes: z.number().optional().describe('Maximum content size in bytes. Content is truncated to fit.'),
        }),
        annotations: {
            readOnlyHint: true,
            openWorldHint: true,
        },
    }, async ({ url, maxBytes }) => {
        try {
            const result = await read(url, { maxBytes: maxBytes ?? undefined });
            if (!result) {
                return {
                    content: [{ type: 'text', text: JSON.stringify({ error: 'Failed to read content', url }) }],
                    isError: true,
                };
            }
            return {
                content: [{ type: 'text', text: JSON.stringify(result) }],
            };
        }
        catch (err) {
            return {
                content: [{ type: 'text', text: `Read failed: ${err.message}` }],
                isError: true,
            };
        }
    });
    // --- apitap_capture ---
    server.registerTool('apitap_capture', {
        description: 'Capture a website\'s API traffic by launching an instrumented browser. ' +
            'Use this when apitap_search returns no results for a site. ' +
            'Navigates to the URL, captures API calls for the specified duration, ' +
            'and generates skill files for future replay. ' +
            'Returns { domains, totalRequests, filtered, skillFiles } summary.',
        inputSchema: z.object({
            url: z.string().describe('URL to capture (e.g. "https://polymarket.com")'),
            duration: z.number().optional().describe('Capture duration in seconds (default: 30)'),
            port: z.number().optional().describe('Connect to specific CDP port instead of scanning'),
        }),
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: true,
        },
    }, async ({ url, duration, port }) => {
        const dur = duration ?? 30;
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);
        const cliArgs = ['--import', 'tsx', 'src/cli.ts', 'capture', url, '--duration', String(dur), '--json', '--no-verify'];
        if (port)
            cliArgs.push('--port', String(port));
        try {
            const { stdout } = await execFileAsync('node', cliArgs, {
                timeout: (dur + 30) * 1000,
                env: { ...process.env, ...(skillsDir ? { APITAP_SKILLS_DIR: skillsDir } : {}) },
            });
            return {
                content: [{ type: 'text', text: stdout }],
            };
        }
        catch (err) {
            return {
                content: [{ type: 'text', text: `Capture failed: ${err.message}` }],
                isError: true,
            };
        }
    });
    // --- apitap_capture_start ---
    server.registerTool('apitap_capture_start', {
        description: 'Start an interactive browser capture session. ' +
            'Launches a browser, navigates to the URL, and begins passively capturing API traffic. ' +
            'Returns a sessionId and a page snapshot with interactive elements (buttons, links, inputs). ' +
            'Use apitap_capture_interact to drive the browser and apitap_capture_finish to save skill files.',
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
    }, async ({ url, headless, allDomains }) => {
        if (sessions.size >= MAX_SESSIONS) {
            return {
                content: [{ type: 'text', text: `Maximum ${MAX_SESSIONS} concurrent sessions. Finish or abort an existing session first.` }],
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
                content: [{ type: 'text', text: JSON.stringify({ sessionId: session.id, snapshot }) }],
            };
        }
        catch (err) {
            return {
                content: [{ type: 'text', text: `Failed to start capture session: ${err.message}` }],
                isError: true,
            };
        }
    });
    // --- apitap_capture_interact ---
    server.registerTool('apitap_capture_interact', {
        description: 'Interact with a live capture session browser. ' +
            'Actions: snapshot (get current state), click (ref), type (ref + text), select (ref + value), ' +
            'navigate (url), scroll (direction), wait (seconds, max 10). ' +
            'Every action returns a fresh page snapshot with updated elements and capture stats. ' +
            'Use element refs (e.g. "e0", "e3") from the snapshot to target clicks and typing.',
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
    }, async ({ sessionId, action, ref, text, value, url, direction, seconds, submit }) => {
        const session = sessions.get(sessionId);
        if (!session) {
            // Clean up expired sessions
            for (const [id, s] of sessions) {
                if (!s.isActive)
                    sessions.delete(id);
            }
            return {
                content: [{ type: 'text', text: `Session "${sessionId}" not found or expired.` }],
                isError: true,
            };
        }
        const result = await session.interact({
            action: action,
            ref,
            text,
            value,
            url,
            direction: direction,
            seconds,
            submit,
        });
        return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            ...(result.success ? {} : { isError: true }),
        };
    });
    // --- apitap_capture_finish ---
    server.registerTool('apitap_capture_finish', {
        description: 'Finish or abort a capture session. ' +
            'Without abort: closes browser, verifies endpoints, signs and writes skill files. ' +
            'With abort: closes browser without saving. ' +
            'Returns { aborted, domains: [{ domain, endpointCount, tiers, skillFile }] }.',
        inputSchema: z.object({
            sessionId: z.string().describe('Session ID from apitap_capture_start'),
            abort: z.boolean().optional().describe('Abort without saving (default: false)'),
        }),
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: false,
        },
    }, async ({ sessionId, abort: shouldAbort }) => {
        const session = sessions.get(sessionId);
        if (!session) {
            // Clean up expired sessions
            for (const [id, s] of sessions) {
                if (!s.isActive)
                    sessions.delete(id);
            }
            return {
                content: [{ type: 'text', text: `Session "${sessionId}" not found or expired.` }],
                isError: true,
            };
        }
        sessions.delete(sessionId);
        try {
            if (shouldAbort) {
                await session.abort();
                return {
                    content: [{ type: 'text', text: JSON.stringify({ aborted: true, domains: [] }) }],
                };
            }
            const result = await session.finish();
            return {
                content: [{ type: 'text', text: JSON.stringify(result) }],
            };
        }
        catch (err) {
            return {
                content: [{ type: 'text', text: `Finish failed: ${err.message}` }],
                isError: true,
            };
        }
    });
    // --- apitap_auth_request ---
    server.registerTool('apitap_auth_request', {
        description: 'Request human authentication for a site that requires login. ' +
            'Opens a VISIBLE browser window where the human can log in, handle 2FA, solve CAPTCHAs. ' +
            'Captures session cookies and auth tokens after login, stores them encrypted. ' +
            'Default timeout is 5 minutes. ' +
            'After success, use apitap_replay or apitap_capture with the domain — auth will be injected automatically. ' +
            'Use this when: replay returns 401/403, discovery detects authRequired, or you know a site needs login.',
        inputSchema: z.object({
            domain: z.string().describe('Domain to authenticate (e.g. "github.com")'),
            loginUrl: z.string().optional().describe('Login page URL (defaults to https://<domain>)'),
            timeout: z.number().optional().describe('Timeout in seconds for human to complete login (default: 300)'),
        }),
        annotations: {
            readOnlyHint: false,
            openWorldHint: true,
        },
    }, async ({ domain, loginUrl, timeout }) => {
        const machineId = await getMachineId();
        const authManager = new AuthManager(APITAP_DIR, machineId);
        try {
            const result = await requestAuth(authManager, {
                domain,
                loginUrl,
                timeout: timeout ? timeout * 1000 : undefined,
            });
            return {
                content: [{ type: 'text', text: JSON.stringify(result) }],
                ...(result.success ? {} : { isError: true }),
            };
        }
        catch (err) {
            return {
                content: [{ type: 'text', text: `Auth request failed: ${err.message}` }],
                isError: true,
            };
        }
    });
    return server;
}
// --- stdio entry point ---
// Only start when run directly (not imported for testing)
const isMainModule = process.argv[1] && (process.argv[1].endsWith('/mcp.ts') ||
    process.argv[1].endsWith('/mcp.js') ||
    process.argv[1].endsWith('/apitap-mcp'));
if (isMainModule) {
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    server.connect(transport).catch((err) => {
        console.error('MCP server failed to start:', err);
        process.exit(1);
    });
}
//# sourceMappingURL=mcp.js.map