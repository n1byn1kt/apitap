// src/serve.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readSkillFile } from './skill/store.js';
import { replayEndpoint } from './replay/engine.js';
import { AuthManager, getMachineId } from './auth/manager.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SkillFile, SkillEndpoint } from './types.js';

const APITAP_DIR = process.env.APITAP_DIR || join(homedir(), '.apitap');

export interface ServeTool {
  name: string;
  description: string;
  endpointId: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/**
 * Build MCP tool definitions from a skill file's endpoints.
 * Each endpoint becomes one tool named `domain_endpointId`.
 */
export function buildServeTools(skill: SkillFile): ServeTool[] {
  return skill.endpoints.map(ep => {
    const properties: Record<string, { type: string; description: string }> = {};
    const required: string[] = [];

    // Path params → required
    const pathParams = ep.path.match(/:([a-zA-Z_]+)/g);
    if (pathParams) {
      for (const raw of pathParams) {
        const name = raw.slice(1);
        properties[name] = { type: 'string', description: `Path parameter` };
        required.push(name);
      }
    }

    // Query params → optional with examples
    for (const [key, val] of Object.entries(ep.queryParams)) {
      properties[key] = {
        type: 'string',
        description: `Query param (example: ${val.example})`,
      };
    }

    // Body variables → optional
    if (ep.requestBody?.variables) {
      for (const varPath of ep.requestBody.variables) {
        properties[varPath] = {
          type: 'string',
          description: `Body variable`,
        };
      }
    }

    return {
      name: `${skill.domain}_${ep.id}`,
      description: `${ep.method} ${ep.path} on ${skill.domain}`,
      endpointId: ep.id,
      inputSchema: {
        type: 'object' as const,
        properties,
        required,
      },
    };
  });
}

export interface ServeOptions {
  skillsDir?: string;
  noAuth?: boolean;
}

/**
 * Create an MCP server that exposes a skill file's endpoints as tools.
 * Each endpoint becomes a callable tool that delegates to the replay engine.
 */
export async function createServeServer(
  domain: string,
  options: ServeOptions = {},
): Promise<McpServer> {
  const skill = await readSkillFile(domain, options.skillsDir);
  if (!skill) {
    throw new Error(`No skill file found for "${domain}". Run: apitap capture ${domain}`);
  }

  if (skill.endpoints.length === 0) {
    throw new Error(`Skill file for "${domain}" has no endpoints.`);
  }

  const tools = buildServeTools(skill);

  // Load auth manager unless --no-auth
  let authManager: AuthManager | undefined;
  if (!options.noAuth) {
    const machineId = await getMachineId();
    authManager = new AuthManager(APITAP_DIR, machineId);
  }

  const server = new McpServer({
    name: `apitap-serve-${domain}`,
    version: '1.0.0',
  });

  // Register one tool per endpoint
  for (const tool of tools) {
    // Build zod schema from tool.inputSchema
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [key, prop] of Object.entries(tool.inputSchema.properties)) {
      const field = z.string().describe(prop.description);
      shape[key] = tool.inputSchema.required.includes(key) ? field : field.optional();
    }

    const endpointId = tool.endpointId;

    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: z.object(shape),
        annotations: {
          readOnlyHint: true,
          openWorldHint: true,
        },
      },
      async (args: Record<string, unknown>) => {
        const endpoint = skill.endpoints.find(e => e.id === endpointId)!;
        const savedHeaders = endpoint.headers;
        try {
          // Inject stored auth without mutating the shared skill object
          if (authManager) {
            const hasStoredPlaceholder = Object.values(savedHeaders).some(v => v === '[stored]');
            if (hasStoredPlaceholder) {
              try {
                const storedAuth = await authManager.retrieve(domain);
                if (storedAuth) {
                  endpoint.headers = { ...savedHeaders, [storedAuth.header]: storedAuth.value };
                }
              } catch {
                // Auth retrieval failed — proceed without
              }
            }
          }

          // Convert args to string params
          const params: Record<string, string> = {};
          for (const [k, v] of Object.entries(args)) {
            if (v !== undefined) params[k] = String(v);
          }

          const result = await replayEndpoint(skill, endpointId, {
            params,
            authManager,
            domain,
          });

          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ status: result.status, data: result.data }),
            }],
          };
        } catch (err: any) {
          return {
            content: [{
              type: 'text' as const,
              text: `Replay failed: ${err.message}`,
            }],
            isError: true,
          };
        } finally {
          // Restore original headers so [stored] placeholders remain for next call
          endpoint.headers = savedHeaders;
        }
      },
    );
  }

  return server;
}
