// src/plugin.ts
import { searchSkills } from './skill/search.js';
import { readSkillFile } from './skill/store.js';
import { replayEndpoint } from './replay/engine.js';
import { AuthManager, getMachineId } from './auth/manager.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface Plugin {
  name: string;
  version: string;
  tools: ToolDefinition[];
}

export interface PluginOptions {
  skillsDir?: string;
  /** @internal Skip SSRF check — for testing only */
  _skipSsrfCheck?: boolean;
}

const APITAP_DIR = join(homedir(), '.apitap');

export function createPlugin(options: PluginOptions = {}): Plugin {
  const skillsDir = options.skillsDir;

  const searchTool: ToolDefinition = {
    name: 'apitap_search',
    description:
      'Search available API skill files for a domain or endpoint. ' +
      'Use this FIRST to check if ApiTap has captured a site\'s API before trying to replay. ' +
      'Returns matching endpoints with replayability tiers: ' +
      'green = safe to replay directly, ' +
      'yellow = needs auth credentials, ' +
      'orange = fragile (CSRF/session-bound), ' +
      'red = needs browser (anti-bot). ' +
      'If not found, use apitap_capture to capture the site first.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query — domain name, endpoint path, or keyword (e.g. "polymarket", "events", "get-markets")',
        },
      },
      required: ['query'],
    },
    execute: async (args) => {
      const query = args.query as string;
      return searchSkills(query, skillsDir);
    },
  };

  const replayTool: ToolDefinition = {
    name: 'apitap_replay',
    description:
      'Replay a captured API endpoint to get live data. ' +
      'Check the endpoint tier first with apitap_search: ' +
      'green = will work, yellow = needs auth, orange/red = may fail. ' +
      'Returns { status, data } with the API response.',
    parameters: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'Domain of the API (e.g. "gamma-api.polymarket.com")',
        },
        endpointId: {
          type: 'string',
          description: 'Endpoint ID from search results (e.g. "get-events")',
        },
        params: {
          type: 'object',
          description: 'Optional key-value parameters for path substitution or query params (e.g. { "id": "123", "limit": "10" })',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['domain', 'endpointId'],
    },
    execute: async (args) => {
      const domain = args.domain as string;
      const endpointId = args.endpointId as string;
      const params = args.params as Record<string, string> | undefined;

      const skill = await readSkillFile(domain, skillsDir);
      if (!skill) {
        return {
          error: `No skill file found for "${domain}". Use apitap_capture to capture it first.`,
        };
      }

      // Inject stored auth if available
      const endpoint = skill.endpoints.find(e => e.id === endpointId);
      if (!endpoint) {
        return {
          error: `Endpoint "${endpointId}" not found. Available: ${skill.endpoints.map(e => e.id).join(', ')}`,
        };
      }

      const hasStoredPlaceholder = Object.values(endpoint.headers).some(v => v === '[stored]');
      if (hasStoredPlaceholder) {
        try {
          const machineId = await getMachineId();
          const authManager = new AuthManager(APITAP_DIR, machineId);
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
          params,
          _skipSsrfCheck: options._skipSsrfCheck,
        });
        return { status: result.status, data: result.data };
      } catch (err: any) {
        return { error: err.message };
      }
    },
  };

  const captureTool: ToolDefinition = {
    name: 'apitap_capture',
    description:
      'Capture a website\'s API traffic by browsing it with an instrumented browser. ' +
      'Use this when apitap_search returns no results for a site. ' +
      'Launches a browser, navigates to the URL, captures API calls for the specified duration, ' +
      'and generates a skill file for future replay. ' +
      'Returns { domains, endpoints, skillFiles } summary.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL to capture (e.g. "https://polymarket.com")',
        },
        duration: {
          type: 'number',
          description: 'Capture duration in seconds (default: 30)',
        },
        allDomains: {
          type: 'boolean',
          description: 'Capture all domains, not just the target domain (default: false)',
        },
      },
      required: ['url'],
    },
    execute: async (args) => {
      const url = args.url as string;
      const duration = (args.duration as number) ?? 30;
      const allDomains = (args.allDomains as boolean) ?? false;

      // Shell out to CLI for capture (it handles browser lifecycle, signing, etc.)
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);

      const cliArgs = ['--import', 'tsx', 'src/cli.ts', 'capture', url, '--duration', String(duration), '--json', '--no-verify'];
      if (allDomains) cliArgs.push('--all-domains');

      try {
        const { stdout } = await execFileAsync('node', cliArgs, {
          timeout: (duration + 30) * 1000,
          env: { ...process.env, ...(skillsDir ? { APITAP_SKILLS_DIR: skillsDir } : {}) },
        });
        return JSON.parse(stdout);
      } catch (err: any) {
        return { error: `Capture failed: ${err.message}` };
      }
    },
  };

  return {
    name: 'apitap',
    version: '0.4.0',
    tools: [searchTool, replayTool, captureTool],
  };
}
