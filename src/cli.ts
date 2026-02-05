// src/cli.ts
import { capture } from './capture/monitor.js';
import { writeSkillFile, readSkillFile, listSkillFiles } from './skill/store.js';
import { replayEndpoint } from './replay/engine.js';

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
    apitap list                List available skill files
    apitap show <domain>       Show endpoints for a domain
    apitap replay <domain> <endpoint-id> [key=value...]
                               Replay an API endpoint

  Options:
    --json                     Output machine-readable JSON
    --duration <seconds>       Stop capture after N seconds
    --port <port>              Connect to specific CDP port
    --launch                   Always launch a new browser
    --attach                   Only attach to existing browser
  `.trim());
}

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

  if (!json) {
    console.log(`\n  🔍 Capturing ${url}...${duration ? ` (${duration}s)` : ' (Ctrl+C to stop)'}\n`);
  }

  let endpointCount = 0;
  let filteredCount = 0;

  const result = await capture({
    url: fullUrl,
    duration,
    port,
    launch: flags.launch === true,
    attach: flags.attach === true,
    onEndpoint: (ep) => {
      endpointCount++;
      if (!json) {
        console.log(`  ✓ ${ep.method.padEnd(6)} ${ep.path}`);
      }
    },
    onFiltered: () => {
      filteredCount++;
    },
  });

  // Write skill files for each domain
  const written: string[] = [];
  for (const [domain, generator] of result.generators) {
    const skill = generator.toSkillFile(domain);
    if (skill.endpoints.length > 0) {
      const path = await writeSkillFile(skill);
      written.push(path);
    }
  }

  if (json) {
    const output = {
      domains: Array.from(result.generators.entries()).map(([domain, gen]) => ({
        domain,
        endpoints: gen.toSkillFile(domain).endpoints.length,
      })),
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

async function handleList(flags: Record<string, string | boolean>): Promise<void> {
  const summaries = await listSkillFiles();
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
    console.log(`  ${s.domain.padEnd(30)} ${String(s.endpointCount).padStart(3)} endpoints   ${ago}`);
  }
  console.log();
}

async function handleShow(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const domain = positional[0];
  if (!domain) {
    console.error('Error: Domain required. Usage: apitap show <domain>');
    process.exit(1);
  }

  const skill = await readSkillFile(domain);
  if (!skill) {
    console.error(`Error: No skill file found for "${domain}". Run \`apitap capture\` first.`);
    process.exit(1);
  }

  const json = flags.json === true;

  if (json) {
    console.log(JSON.stringify(skill, null, 2));
    return;
  }

  console.log(`\n  ${skill.domain} — ${skill.endpoints.length} endpoints (captured ${timeAgo(skill.capturedAt)})\n`);
  for (const ep of skill.endpoints) {
    const shape = ep.responseShape.type;
    const fields = ep.responseShape.fields?.length ?? 0;
    console.log(`  ${ep.method.padEnd(6)} ${ep.path.padEnd(35)} ${shape}${fields ? ` (${fields} fields)` : ''}`);
  }
  console.log(`\n  Replay: apitap replay ${skill.domain} <endpoint-id>\n`);
}

async function handleReplay(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const [domain, endpointId, ...paramArgs] = positional;
  if (!domain || !endpointId) {
    console.error('Error: Domain and endpoint required. Usage: apitap replay <domain> <endpoint-id> [key=value...]');
    process.exit(1);
  }

  const skill = await readSkillFile(domain);
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

  const result = await replayEndpoint(skill, endpointId, Object.keys(params).length > 0 ? params : undefined);
  const json = flags.json === true;

  if (json) {
    console.log(JSON.stringify({ status: result.status, data: result.data }, null, 2));
  } else {
    console.log(`\n  Status: ${result.status}\n`);
    console.log(JSON.stringify(result.data, null, 2));
    console.log();
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

async function main(): Promise<void> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));

  switch (command) {
    case 'capture':
      await handleCapture(positional, flags);
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
    default:
      printUsage();
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
