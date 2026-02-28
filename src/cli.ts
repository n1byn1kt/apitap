#!/usr/bin/env node
// src/cli.ts
import { capture } from './capture/monitor.js';
import { writeSkillFile, readSkillFile, listSkillFiles } from './skill/store.js';
import { replayEndpoint } from './replay/engine.js';
import { AuthManager, getMachineId } from './auth/manager.js';
import { deriveKey } from './auth/crypto.js';
import { signSkillFile } from './skill/signing.js';
import { importSkillFile } from './skill/importer.js';
import { resolveAndValidateUrl } from './skill/ssrf.js';
import { verifyEndpoints } from './capture/verifier.js';
import { searchSkills } from './skill/search.js';
import { refreshTokens } from './auth/refresh.js';
import { parseJwtClaims } from './capture/entropy.js';
import { createServeServer, buildServeTools } from './serve.js';
import { buildInspectReport, formatInspectHuman } from './inspect/report.js';
import { generateStatsReport, formatStatsHuman } from './stats/report.js';
import { detectAntiBot, type AntiBotSignal } from './capture/anti-bot.js';
import { discover } from './discovery/index.js';
import { peek } from './read/peek.js';
import { read } from './read/index.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
const VERSION = pkg.version as string;

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) {
      const key = rest[i].slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(rest[i]);
    }
  }

  return { command, positional, flags };
}

function printUsage(): void {
  console.log(`
  apitap — API interception for AI agents

  Usage:
    apitap capture <url>       Capture API traffic from a website
    apitap discover <url>      Detect APIs without a browser (fast recon)
    apitap inspect <url>       Discover APIs without saving (X-ray vision)
    apitap search <query>      Search skill files for a domain or endpoint
    apitap list                List available skill files
    apitap show <domain>       Show endpoints for a domain
    apitap replay <domain> <endpoint-id> [key=value...]
                               Replay an API endpoint
    apitap import <file>       Import a skill file with safety validation
    apitap refresh <domain>    Refresh auth tokens via browser
    apitap auth [domain]       View or manage stored auth
    apitap serve <domain>      Serve a skill file as an MCP server
    apitap browse <url>        Browse a URL (discover + replay in one step)
    apitap peek <url>          Zero-cost triage (HEAD only)
    apitap read <url>          Extract content without a browser
    apitap stats               Show token savings report

  Discover options:
    --json                     Output machine-readable JSON
    --save                     Save discovered skill file to disk

  Capture options:
    --json                     Output machine-readable JSON
    --duration <seconds>       Stop capture after N seconds
    --port <port>              Connect to specific CDP port
    --launch                   Always launch a new browser
    --attach                   Only attach to existing browser
    --all-domains              Capture traffic from all domains (default: target only)
    --preview                  Include response data previews in skill files
    --no-scrub                 Disable PII scrubbing
    --no-verify                Skip auto-verification of GET endpoints
    --verify-posts             Also verify POST endpoints by replaying them (may cause side effects)

  Replay options:
    --json                     Output machine-readable JSON
    --fresh                    Force token refresh before replay
    --max-bytes <bytes>        Truncate response to fit within byte limit

  Auth options:
    --list                     List all domains with stored auth
    --clear                    Clear auth for a domain
    --json                     Output machine-readable JSON

  Browse options:
    --json                     Output machine-readable JSON
    --max-bytes <bytes>        Truncate response to fit within byte limit (default: 50000)

  Peek options:
    --json                     Output machine-readable JSON

  Read options:
    --json                     Output machine-readable JSON
    --max-bytes <bytes>        Truncate content to fit within byte limit

  Import options:
    --yes                      Skip confirmation prompt

  Serve options:
    --json                     Output tool list as JSON on stderr
    --no-auth                  Skip loading stored auth
  `.trim());
}

const APITAP_DIR = process.env.APITAP_DIR || join(homedir(), '.apitap');
const SKILLS_DIR = process.env.APITAP_SKILLS_DIR || undefined;

/** Get machine ID, allowing override via env var for testing */
async function getEffectiveMachineId(): Promise<string> {
  return process.env.APITAP_MACHINE_ID || await getMachineId();
}

const TIER_BADGES: Record<string, string> = {
  green: '[green]',
  yellow: '[yellow]',
  orange: '[orange]',
  red: '[red]',
  unknown: '[ ]',
};

async function handleCapture(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const url = positional[0];
  if (!url) {
    console.error('Error: URL required. Usage: apitap capture <url>');
    process.exit(1);
  }

  const fullUrl = url.startsWith('http') ? url : `https://${url}`;
  const json = flags.json === true;
  const duration = typeof flags.duration === 'string' ? parseInt(flags.duration, 10) : undefined;
  const port = typeof flags.port === 'string' ? parseInt(flags.port, 10) : undefined;
  const skipVerify = flags['no-verify'] === true;
  const verifyPosts = flags['verify-posts'] === true;

  if (!json) {
    const domainOnly = flags['all-domains'] !== true;
    console.log(`\n  🔍 Capturing ${url}...${duration ? ` (${duration}s)` : ' (Ctrl+C to stop)'}${domainOnly ? ' [domain-only]' : ' [all domains]'}\n`);
  }

  let endpointCount = 0;
  let filteredCount = 0;

  const result = await capture({
    url: fullUrl,
    duration,
    port,
    launch: flags.launch === true,
    attach: flags.attach === true,
    authDir: APITAP_DIR,
    allDomains: flags['all-domains'] === true,
    enablePreview: flags.preview === true,
    scrub: flags['no-scrub'] !== true,
    onEndpoint: (ep) => {
      endpointCount++;
      if (!json) {
        console.log(`  ✓ ${ep.method.padEnd(6)} ${ep.path}`);
      }
    },
    onFiltered: () => {
      filteredCount++;
    },
    onIdle: () => {
      if (!json) {
        console.log(`\n  ⏸ No new endpoints for 15s — looks complete. Ctrl+C to finish.\n`);
      }
    },
  });

  // Get machine ID for signing and auth storage
  const machineId = await getMachineId();
  const key = deriveKey(machineId);
  const authManager = new AuthManager(APITAP_DIR, machineId);

  // Write skill files for each domain
  const written: string[] = [];
  for (const [domain, generator] of result.generators) {
    let skill = generator.toSkillFile(domain, {
      domBytes: result.domBytes,
      totalRequests: result.totalRequests,
    });
    if (skill.endpoints.length > 0) {
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

      // Auto-verify GET endpoints
      if (!skipVerify) {
        if (!json) {
          console.log(`\n  🔍 Verifying ${domain}...`);
        }
        skill = await verifyEndpoints(skill, { verifyPosts });
        if (!json) {
          for (const ep of skill.endpoints) {
            const tier = ep.replayability?.tier ?? 'unknown';
            const badge = TIER_BADGES[tier];
            const check = ep.replayability?.verified ? ' ✓' : '';
            console.log(`  ${badge}${check} ${ep.method.padEnd(6)} ${ep.path}`);
          }
        }
      }

      // Sign the skill file
      skill = signSkillFile(skill, key);

      const path = await writeSkillFile(skill);
      written.push(path);
    }
  }

  if (json) {
    const output = {
      domains: Array.from(result.generators.entries()).map(([domain, gen]) => {
        const skill = gen.toSkillFile(domain, {
          domBytes: result.domBytes,
          totalRequests: result.totalRequests,
        });
        return {
          domain,
          endpoints: skill.endpoints.map(ep => ({
            id: ep.id,
            method: ep.method,
            path: ep.path,
            ...(ep.replayability ? { replayability: ep.replayability } : {}),
            ...(ep.pagination ? { pagination: ep.pagination } : {}),
          })),
        };
      }),
      totalRequests: result.totalRequests,
      filtered: result.filteredRequests,
      skillFiles: written,
    };
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`\n  📋 Capture complete\n`);
    console.log(`  Endpoints:  ${endpointCount} discovered`);
    console.log(`  Requests:   ${result.totalRequests} total, ${result.filteredRequests} filtered`);
    for (const path of written) {
      console.log(`  Skill file: ${path}`);
    }
    console.log();
  }
}

async function handleSearch(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const query = positional.join(' ');
  if (!query) {
    console.error('Error: Query required. Usage: apitap search <query>');
    process.exit(1);
  }

  const json = flags.json === true;
  const result = await searchSkills(query, SKILLS_DIR);

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (!result.found) {
    console.log(`\n  ${result.suggestion}\n`);
    return;
  }

  console.log();
  for (const r of result.results!) {
    const tierBadge = TIER_BADGES[r.tier] || '[?]';
    const verified = r.verified ? ' ✓' : '';
    console.log(`  ${tierBadge}${verified} ${r.domain.padEnd(30)} ${r.method.padEnd(6)} ${r.path.padEnd(24)} ${r.endpointId}`);
  }
  console.log();
}

async function handleList(flags: Record<string, string | boolean>): Promise<void> {
  const summaries = await listSkillFiles(SKILLS_DIR);
  const json = flags.json === true;

  if (json) {
    console.log(JSON.stringify(summaries, null, 2));
    return;
  }

  if (summaries.length === 0) {
    console.log('\n  No skill files found. Run `apitap capture <url>` first.\n');
    return;
  }

  console.log();
  for (const s of summaries) {
    const ago = timeAgo(s.capturedAt);
    const prov = s.provenance === 'self' ? '✓' : s.provenance === 'imported' ? '⬇' : '?';
    console.log(`  ${prov} ${s.domain.padEnd(28)} ${String(s.endpointCount).padStart(3)} endpoints   ${ago}`);
  }
  console.log();
}

async function handleShow(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const domain = positional[0];
  if (!domain) {
    console.error('Error: Domain required. Usage: apitap show <domain>');
    process.exit(1);
  }

  const skill = await readSkillFile(domain, SKILLS_DIR);
  if (!skill) {
    console.error(`Error: No skill file found for "${domain}". Run \`apitap capture\` first.`);
    process.exit(1);
  }

  const json = flags.json === true;

  if (json) {
    console.log(JSON.stringify(skill, null, 2));
    return;
  }

  const provLabel = skill.provenance === 'self' ? 'signed ✓' : skill.provenance === 'imported' ? 'imported ⬇' : 'unsigned';
  console.log(`\n  ${skill.domain} — ${skill.endpoints.length} endpoints (captured ${timeAgo(skill.capturedAt)}) [${provLabel}]\n`);
  for (const ep of skill.endpoints) {
    const shape = ep.responseShape.type;
    const fields = ep.responseShape.fields?.length ?? 0;
    const hasAuth = Object.values(ep.headers).some(v => v === '[stored]');
    const authBadge = hasAuth ? ' 🔑' : '';
    const tier = ep.replayability?.tier ?? 'unknown';
    const tierBadge = TIER_BADGES[tier];
    const verified = ep.replayability?.verified ? ' ✓' : '';
    const pagBadge = ep.pagination ? ` 📄${ep.pagination.type}` : '';
    const bodyBadge = ep.requestBody ? ` 📦${ep.requestBody.contentType.split('/')[1] || 'body'}` : '';
    console.log(`  ${tierBadge}${verified} ${ep.method.padEnd(6)} ${ep.path.padEnd(30)} ${shape}${fields ? ` (${fields} fields)` : ''}${authBadge}${pagBadge}${bodyBadge}`);
  }
  console.log(`\n  Replay: apitap replay ${skill.domain} <endpoint-id>\n`);
}

async function handleReplay(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const [domain, endpointId, ...paramArgs] = positional;
  if (!domain || !endpointId) {
    console.error('Error: Domain and endpoint required. Usage: apitap replay <domain> <endpoint-id> [key=value...]');
    process.exit(1);
  }

  const skill = await readSkillFile(domain, SKILLS_DIR);
  if (!skill) {
    console.error(`Error: No skill file found for "${domain}".`);
    process.exit(1);
  }

  // Parse key=value params
  const params: Record<string, string> = {};
  for (const arg of paramArgs) {
    const eq = arg.indexOf('=');
    if (eq > 0) {
      params[arg.slice(0, eq)] = arg.slice(eq + 1);
    }
  }

  // Merge stored auth into endpoint headers for replay
  const machineId = await getMachineId();
  const authManager = new AuthManager(APITAP_DIR, machineId);
  const storedAuth = await authManager.retrieve(domain);

  // Check for [stored] placeholders and warn if auth missing
  const endpoint = skill.endpoints.find(e => e.id === endpointId);
  if (endpoint) {
    const hasStoredPlaceholder = Object.values(endpoint.headers).some(v => v === '[stored]');
    if (hasStoredPlaceholder && !storedAuth) {
      console.error(`Warning: Endpoint requires auth but no stored credentials found for "${domain}".`);
      console.error(`  Run \`apitap capture ${domain}\` to capture fresh credentials.\n`);
    }

    // Inject stored auth into a copy of the skill for replay
    if (storedAuth) {
      endpoint.headers[storedAuth.header] = storedAuth.value;
    }
  }

  const fresh = flags.fresh === true;
  const json = flags.json === true;
  const maxBytes = typeof flags['max-bytes'] === 'string' ? parseInt(flags['max-bytes'], 10) : undefined;

  const result = await replayEndpoint(skill, endpointId, {
    params: Object.keys(params).length > 0 ? params : undefined,
    authManager,
    domain,
    fresh,
    maxBytes,
    _skipSsrfCheck: process.env.APITAP_SKIP_SSRF_CHECK === '1',
  });

  if (json) {
    console.log(JSON.stringify({ status: result.status, data: result.data }, null, 2));
  } else {
    console.log(`\n  Status: ${result.status}\n`);
    console.log(JSON.stringify(result.data, null, 2));
    console.log();
  }
}

async function handleImport(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const filePath = positional[0];
  if (!filePath) {
    console.error('Error: File path required. Usage: apitap import <file>');
    process.exit(1);
  }

  const json = flags.json === true;

  // Get local key for signature verification
  const machineId = await getMachineId();
  const key = deriveKey(machineId);

  // DNS-resolving SSRF check before importing (prevents DNS rebinding attacks)
  try {
    const raw = JSON.parse(await import('node:fs/promises').then(fs => fs.readFile(filePath, 'utf-8')));
    if (raw.baseUrl) {
      const dnsCheck = await resolveAndValidateUrl(raw.baseUrl);
      if (!dnsCheck.safe) {
        const msg = `DNS rebinding risk: ${dnsCheck.reason}`;
        if (json) {
          console.log(JSON.stringify({ success: false, reason: msg }));
        } else {
          console.error(`Error: ${msg}`);
        }
        process.exit(1);
      }
    }
  } catch {
    // Parse errors will be caught by importSkillFile
  }

  const result = await importSkillFile(filePath, undefined, key);

  if (!result.success) {
    if (json) {
      console.log(JSON.stringify({ success: false, reason: result.reason }));
    } else {
      console.error(`Error: ${result.reason}`);
    }
    process.exit(1);
  }

  if (json) {
    console.log(JSON.stringify({ success: true, skillFile: result.skillFile }));
  } else {
    console.log(`\n  ✓ Imported skill file: ${result.skillFile}\n`);
  }
}

async function handleRefresh(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const domain = positional[0];
  if (!domain) {
    console.error('Error: Domain required. Usage: apitap refresh <domain>');
    process.exit(1);
  }

  const skill = await readSkillFile(domain, SKILLS_DIR);
  if (!skill) {
    console.error(`Error: No skill file found for "${domain}".`);
    process.exit(1);
  }

  const machineId = await getEffectiveMachineId();
  const authManager = new AuthManager(APITAP_DIR, machineId);
  const json = flags.json === true;

  if (!json) {
    console.log(`\n  🔄 Refreshing tokens for ${domain}...`);
  }

  const result = await refreshTokens(skill, authManager, {
    domain,
    browserMode: skill.auth?.captchaRisk ? 'visible' : 'headless',
  });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.success) {
    if (result.oauthRefreshed) {
      console.log(`  ✓ OAuth token refreshed via token endpoint`);
    }
    if (Object.keys(result.tokens).length > 0) {
      console.log(`  ✓ Browser tokens refreshed: ${Object.keys(result.tokens).join(', ')}`);
    }
    if (result.captchaDetected) {
      console.log(`    (captcha solved: ${result.captchaDetected})`);
    }
    console.log();
  } else {
    console.error(`  ✗ Refresh failed: ${result.error || 'no tokens captured'}`);
    process.exit(1);
  }
}

async function handleAuth(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const domain = positional[0];
  const json = flags.json === true;
  const machineId = await getEffectiveMachineId();
  const authManager = new AuthManager(APITAP_DIR, machineId);

  // List all domains
  if (flags.list === true) {
    const domains = await authManager.listDomains();
    if (json) {
      console.log(JSON.stringify({ domains }, null, 2));
    } else {
      if (domains.length === 0) {
        console.log('\n  No stored auth\n');
      } else {
        console.log('\n  Domains with stored auth:');
        for (const d of domains) {
          console.log(`    ${d}`);
        }
        console.log();
      }
    }
    return;
  }

  // Require domain for other operations
  if (!domain) {
    console.error('Error: Domain required. Usage: apitap auth <domain> [--clear] [--json]');
    console.error('       apitap auth --list [--json]');
    process.exit(1);
  }

  // Clear auth for domain
  if (flags.clear === true) {
    await authManager.clear(domain);
    if (json) {
      console.log(JSON.stringify({ success: true, domain, cleared: true }));
    } else {
      console.log(`\n  ✓ Cleared auth for ${domain}\n`);
    }
    return;
  }

  // Show auth status for domain
  const auth = await authManager.retrieve(domain);
  const tokens = await authManager.retrieveTokens(domain);
  const session = await authManager.retrieveSession(domain);
  const oauthCreds = await authManager.retrieveOAuthCredentials(domain);

  // Check for JWT expiry
  let jwtExpiry: string | undefined;
  if (auth?.value) {
    const raw = auth.value.startsWith('Bearer ') ? auth.value.slice(7) : auth.value;
    const jwt = parseJwtClaims(raw);
    if (jwt?.exp) {
      const expDate = new Date(jwt.exp * 1000);
      const isExpired = expDate.getTime() < Date.now();
      jwtExpiry = isExpired ? `expired ${timeAgo(expDate.toISOString())}` : `expires ${expDate.toISOString()}`;
    }
  }

  // Read skill file for OAuth config (non-secret)
  const skill = await readSkillFile(domain, SKILLS_DIR);
  const oauthConfig = skill?.auth?.oauthConfig;

  const status = {
    domain,
    hasHeaderAuth: !!auth,
    headerAuthType: auth?.type,
    jwtExpiry,
    tokens: tokens ? Object.keys(tokens) : [],
    tokenRefreshTimes: tokens
      ? Object.fromEntries(
          Object.entries(tokens).map(([k, v]) => [k, v.refreshedAt])
        )
      : {},
    hasSession: !!session,
    sessionSavedAt: session?.savedAt,
    hasOAuth: !!oauthCreds,
    oauthConfig: oauthConfig ?? undefined,
  };

  if (json) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    console.log(`\n  Auth status for ${domain}:`);
    console.log(`    Header auth: ${auth ? `${auth.type} (${auth.header})` : 'none'}`);
    if (jwtExpiry) {
      console.log(`    JWT: ${jwtExpiry}`);
    }
    if (oauthConfig) {
      console.log(`    OAuth: ${oauthConfig.grantType} via ${oauthConfig.tokenEndpoint}`);
      if (oauthCreds?.refreshToken) {
        console.log(`    Refresh token: stored`);
      }
    }
    console.log(`    Tokens: ${tokens ? Object.keys(tokens).join(', ') || 'none' : 'none'}`);
    if (tokens) {
      for (const [name, info] of Object.entries(tokens)) {
        console.log(`      ${name}: refreshed ${timeAgo(info.refreshedAt)}`);
      }
    }
    console.log(`    Session cache: ${session ? `saved ${timeAgo(session.savedAt)}` : 'none'}`);
    console.log();
  }
}

async function handleServe(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const domain = positional[0];
  if (!domain) {
    console.error('Error: Domain required. Usage: apitap serve <domain>');
    process.exit(1);
  }

  const noAuth = flags['no-auth'] === true;
  const json = flags.json === true;

  try {
    const server = await createServeServer(domain, {
      skillsDir: SKILLS_DIR,
      noAuth,
    });

    // Print tool list to stderr (stdout is the MCP transport)
    const skill = await readSkillFile(domain, SKILLS_DIR);
    const tools = buildServeTools(skill!);

    if (json) {
      console.error(JSON.stringify(tools.map(t => ({ name: t.name, description: t.description }))));
    } else {
      console.error(`apitap serve: ${domain} (${tools.length} tools)`);
      for (const tool of tools) {
        console.error(`  ${tool.name}`);
      }
    }

    // Start stdio transport
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

function timeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

async function handleInspect(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const url = positional[0];
  if (!url) {
    console.error('Usage: apitap inspect <url>');
    process.exit(1);
  }

  const json = flags.json === true;
  const duration = typeof flags.duration === 'string' ? parseInt(flags.duration, 10) : 30;

  if (!json) {
    console.log(`\n  Inspecting ${url} (${duration}s scan)...\n`);
  }

  // Track anti-bot signals during capture
  const antiBotSignals = new Set<AntiBotSignal>();

  const result = await capture({
    url,
    port: typeof flags.port === 'string' ? parseInt(flags.port, 10) : undefined,
    launch: flags.launch === true,
    attach: flags.attach === true,
    authDir: APITAP_DIR,
    duration,
    allDomains: flags['all-domains'] === true,
    enablePreview: false,
    scrub: true,
    onEndpoint: (ep) => {
      if (!json) {
        console.log(`  ✓ ${ep.method.padEnd(6)} ${ep.path}`);
      }
    },
  });

  // Build skill files (without writing to disk), verify endpoints, and detect anti-bot
  const skills = new Map<string, import('./types.js').SkillFile>();
  for (const [domain, generator] of result.generators) {
    let skill = generator.toSkillFile(domain, {
      domBytes: result.domBytes,
      totalRequests: result.totalRequests,
    });
    const verifyPosts = flags['verify-posts'] === true;
    skill = await verifyEndpoints(skill, { verifyPosts });
    if (skill.endpoints.length > 0) {
      skills.set(domain, skill);
    }
  }

  // Extract target domain from URL
  let targetDomain: string;
  try {
    targetDomain = new URL(url.startsWith('http') ? url : `https://${url}`).hostname;
  } catch {
    targetDomain = url;
  }

  const report = buildInspectReport({
    skills,
    totalRequests: result.totalRequests,
    filteredRequests: result.filteredRequests,
    duration,
    domBytes: result.domBytes,
    antiBotSignals: [...antiBotSignals],
    targetDomain,
  });

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatInspectHuman(report));
  }
}

async function handleStats(flags: Record<string, string | boolean>): Promise<void> {
  const json = flags.json === true;
  const skillsDir = SKILLS_DIR || join(APITAP_DIR, 'skills');

  const report = await generateStatsReport(skillsDir);

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatStatsHuman(report));
  }
}

async function handleDiscover(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const url = positional[0];
  if (!url) {
    console.error('Error: URL required. Usage: apitap discover <url>');
    process.exit(1);
  }

  const json = flags.json === true;
  const save = flags.save === true;

  if (!json) {
    console.log(`\n  Discovering APIs for ${url}...\n`);
  }

  const result = await discover(url);

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    // Confidence summary
    const confidenceLabels: Record<string, string> = {
      high: 'High — API spec or strong framework signals found',
      medium: 'Medium — known framework detected',
      low: 'Low — some API patterns detected',
      none: 'None — no API patterns found',
    };
    console.log(`  Confidence: ${confidenceLabels[result.confidence]}`);
    console.log(`  Duration:   ${result.duration}ms`);

    if (result.frameworks && result.frameworks.length > 0) {
      console.log(`\n  Frameworks:`);
      for (const f of result.frameworks) {
        console.log(`    ${f.name} (${f.confidence}) — ${f.apiPatterns.length} predicted patterns`);
      }
    }

    if (result.specs && result.specs.length > 0) {
      console.log(`\n  API Specs:`);
      for (const s of result.specs) {
        console.log(`    ${s.type} ${s.version ?? ''} — ${s.url}${s.endpointCount ? ` (${s.endpointCount} endpoints)` : ''}`);
      }
    }

    if (result.probes && result.probes.length > 0) {
      const apiProbes = result.probes.filter(p => p.isApi);
      if (apiProbes.length > 0) {
        console.log(`\n  API Paths:`);
        for (const p of apiProbes) {
          console.log(`    ${p.method} ${p.path} → ${p.status} (${p.contentType})`);
        }
      }
    }

    if (result.hints && result.hints.length > 0) {
      console.log(`\n  Hints:`);
      for (const h of result.hints) {
        console.log(`    ${h}`);
      }
    }

    if (result.skillFile) {
      console.log(`\n  Skill file: ${result.skillFile.endpoints.length} endpoints predicted`);
    }

    if (result.confidence === 'none') {
      console.log(`\n  Recommendation: Run \`apitap capture ${url}\` for browser-based discovery`);
    }

    console.log();
  }

  // Save skill file if requested and available
  if (save && result.skillFile) {
    const { writeSkillFile } = await import('./skill/store.js');
    const { signSkillFile } = await import('./skill/signing.js');
    const { deriveKey } = await import('./auth/crypto.js');
    const machineId = await getMachineId();
    const key = deriveKey(machineId);

    const signed = signSkillFile(result.skillFile, key);
    const path = await writeSkillFile(signed, SKILLS_DIR);

    if (json) {
      console.log(JSON.stringify({ saved: path }));
    } else {
      console.log(`  Saved: ${path}\n`);
    }
  }
}

async function handleBrowse(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const url = positional[0];
  if (!url) {
    console.error('Error: URL required. Usage: apitap browse <url>');
    process.exit(1);
  }

  const json = flags.json === true;
  const fullUrl = url.startsWith('http') ? url : `https://${url}`;

  if (!json) {
    console.log(`\n  Browsing ${url}...\n`);
  }

  const maxBytes = typeof flags['max-bytes'] === 'string' ? parseInt(flags['max-bytes'], 10) : 50_000;

  const { browse } = await import('./orchestration/browse.js');
  const { SessionCache } = await import('./orchestration/cache.js');

  const result = await browse(fullUrl, {
    skillsDir: SKILLS_DIR,
    cache: new SessionCache(),
    maxBytes,
    _skipSsrfCheck: process.env.APITAP_SKIP_SSRF_CHECK === '1',
  });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.success) {
    console.log(`  ✓ ${result.domain} → ${result.endpointId} (${result.tier})`);
    console.log(`  Status: ${result.status}\n`);
    console.log(JSON.stringify(result.data, null, 2));
    console.log();
  } else {
    console.log(`  ✗ ${result.reason}`);
    if (result.suggestion === 'capture_needed') {
      console.log(`\n  Recommendation: apitap capture ${result.url}\n`);
    }
  }
}

async function handlePeek(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const url = positional[0];
  if (!url) {
    console.error('Error: URL required. Usage: apitap peek <url>');
    process.exit(1);
  }

  const json = flags.json === true;
  const fullUrl = url.startsWith('http') ? url : `https://${url}`;

  if (!json) {
    console.log(`\n  Peeking at ${url}...\n`);
  }

  const result = await peek(fullUrl);

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const icon = result.accessible ? '\u2713' : '\u2717';
  console.log(`  ${icon} ${result.recommendation} (${result.status})`);
  if (result.server) console.log(`  Server: ${result.server}`);
  if (result.framework) console.log(`  Framework: ${result.framework}`);
  if (result.botProtection) console.log(`  Bot protection: ${result.botProtection}`);
  if (result.signals.length > 0) console.log(`  Signals: ${result.signals.join(', ')}`);
  console.log();
}

async function handleRead(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const url = positional[0];
  if (!url) {
    console.error('Error: URL required. Usage: apitap read <url>');
    process.exit(1);
  }

  const json = flags.json === true;
  const fullUrl = url.startsWith('http') ? url : `https://${url}`;
  const maxBytes = typeof flags['max-bytes'] === 'string' ? parseInt(flags['max-bytes'], 10) : undefined;

  if (!json) {
    console.log(`\n  Reading ${url}...\n`);
  }

  const result = await read(fullUrl, { maxBytes });

  if (!result) {
    if (json) {
      console.log(JSON.stringify({ error: 'Failed to read content' }));
    } else {
      console.error('  Failed to read content\n');
    }
    process.exit(1);
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.title) console.log(`  ${result.title}`);
  console.log(`  Source: ${result.metadata.source} | ~${result.cost.tokens} tokens\n`);
  console.log(result.content);
  console.log();
}

async function main(): Promise<void> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));

  // Handle --version flag before command dispatch
  if (command === '--version' || command === 'version' || flags.version === true) {
    console.log(VERSION);
    return;
  }

  switch (command) {
    case 'capture':
      await handleCapture(positional, flags);
      break;
    case 'discover':
      await handleDiscover(positional, flags);
      break;
    case 'list':
      await handleList(flags);
      break;
    case 'show':
      await handleShow(positional, flags);
      break;
    case 'replay':
      await handleReplay(positional, flags);
      break;
    case 'search':
      await handleSearch(positional, flags);
      break;
    case 'import':
      await handleImport(positional, flags);
      break;
    case 'refresh':
      await handleRefresh(positional, flags);
      break;
    case 'auth':
      await handleAuth(positional, flags);
      break;
    case 'serve':
      await handleServe(positional, flags);
      break;
    case 'inspect':
      await handleInspect(positional, flags);
      break;
    case 'stats':
      await handleStats(flags);
      break;
    case 'browse':
      await handleBrowse(positional, flags);
      break;
    case 'peek':
      await handlePeek(positional, flags);
      break;
    case 'read':
      await handleRead(positional, flags);
      break;
    default:
      printUsage();
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
