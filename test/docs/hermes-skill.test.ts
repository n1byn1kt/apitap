import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const skillPath = join(repoRoot, 'skills', 'hermes', 'apitap', 'SKILL.md');

function readSkill(): string {
  assert.ok(existsSync(skillPath), `missing ${skillPath}`);
  return readFileSync(skillPath, 'utf8');
}

function frontmatter(source: string): Record<string, any> {
  const match = source.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, 'SKILL.md must start with a YAML frontmatter block');
  return yaml.load(match[1]) as Record<string, any>;
}

describe('hermes skill file', () => {
  it('has the frontmatter Hermes needs', () => {
    const fm = frontmatter(readSkill());
    assert.equal(fm.name, 'apitap');
    assert.match(fm.version, /^\d+\.\d+\.\d+$/);
    assert.equal(fm.license, 'Apache-2.0');
    assert.equal(fm.author, 'ApiTap Contributors');
    // No windows: the Setup steps use `command -v` and a POSIX <prefix>/bin path.
    assert.deepEqual(fm.platforms, ['linux', 'macos']);
    assert.deepEqual(fm.metadata.hermes.requires_toolsets, ['terminal']);
    assert.ok(Array.isArray(fm.metadata.hermes.tags) && fm.metadata.hermes.tags.length > 0);
  });

  it('does not hide behind the browser toolset', () => {
    const source = readSkill();
    assert.ok(!/fallback_for_toolsets/.test(source));
    assert.ok(!/fallback_for_tools/.test(source));
  });

  it('leads the description with a trigger phrase', () => {
    const fm = frontmatter(readSkill());
    assert.match(fm.description, /^Use when /);
    assert.ok(fm.description.length >= 80, 'description is the only discovery surface — keep it substantive');
  });

  it('never claims MIT', () => {
    assert.ok(!/\bMIT\b/.test(readSkill()));
  });

  it('does not document the broken scoped npx form as usage', () => {
    const source = readSkill();
    for (const line of source.split('\n')) {
      if (!line.includes('npx @apitap/core')) continue;
      assert.match(
        line,
        /broken|does not work|do not/i,
        `line presents the broken scoped npx form as usage: ${line}`,
      );
    }
  });

  it('does not document the stale --params replay form', () => {
    assert.ok(!/--params/.test(readSkill()));
  });

  it('references no support files (a missing one silently breaks install)', () => {
    // Mirrors Hermes' tools/skills_hub.py::_referenced_support_paths.
    const localLink = /(?:\]\(|`|(?:^|[\s"']))((?:references|templates|scripts|assets|examples)\/[^\s)`"'<>]+)/gm;
    const hits = [...readSkill().matchAll(localLink)].map((m) => m[1]);
    assert.deepEqual(hits, [], 'Hermes would try to fetch these files and fail the install');
  });

  it('contains no invisible unicode', () => {
    // Zero-width space/joiners (U+200B-U+200D), word joiner (U+2060),
    // invisible math operators (U+2062-U+2064), BOM/zero-width no-break
    // space (U+FEFF), and bidi control characters (U+202A-U+202E,
    // U+2066-U+2069). Written as \u escapes so the class itself is
    // reviewable in a diff/editor, not as literal invisible characters.
    const invisible = /[\u200B-\u200D\u2060\u2062-\u2064\uFEFF\u202A-\u202E\u2066-\u2069]/;
    assert.ok(!invisible.test(readSkill()));
  });
});

const cliPath = join(repoRoot, 'src', 'cli.ts');

/**
 * Commands the real CLI dispatches on, parsed from main()'s command-dispatch
 * switch specifically — not just any `case '...':` in the file, so an
 * unrelated future string switch elsewhere in src/cli.ts can't silently
 * widen this oracle.
 */
function cliCommands(): Set<string> {
  const source = readFileSync(cliPath, 'utf8');
  const dispatch = source.match(
    /async function main\(\)[\s\S]*?switch \(command\) \{([\s\S]*?)\n\s*\}\n\}\n\nmain\(\)\.catch/,
  );
  assert.ok(
    dispatch,
    "couldn't locate main()'s command-dispatch switch in src/cli.ts — cliCommands()'s anchor needs updating to match the refactor",
  );
  const found = new Set(
    [...dispatch![1].matchAll(/^\s*case '([a-z][a-z-]*)':/gm)].map((m) => m[1]),
  );
  // Sanity-check the parse itself before trusting it as an oracle.
  for (const anchor of ['read', 'peek', 'replay', 'capture', 'browse']) {
    assert.ok(found.has(anchor), `CLI parse looks wrong — no case for '${anchor}'`);
  }
  return found;
}

/** Every code span or fenced code block in the document, as raw text chunks. */
function codeChunks(source: string): string[] {
  return [
    ...[...source.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]),
    ...[...source.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]),
  ];
}

/** Every `apitap <cmd>` that appears in a code span or fenced code block. */
function documentedCommands(source: string): string[] {
  const commands = new Set<string>();
  for (const chunk of codeChunks(source)) {
    for (const match of chunk.matchAll(/\bapitap ([a-z][a-z-]*)/g)) commands.add(match[1]);
  }
  return [...commands].sort();
}

/** Every `--flag` token that appears in a code span or fenced code block. */
function documentedFlags(source: string): string[] {
  const flags = new Set<string>();
  for (const chunk of codeChunks(source)) {
    for (const match of chunk.matchAll(/--([a-z][a-z-]*)/g)) flags.add(match[1]);
  }
  return [...flags].sort();
}

describe('hermes skill documents the real CLI', () => {
  it('documents commands that actually exist', () => {
    const documented = documentedCommands(readSkill());
    assert.ok(documented.length >= 8, `expected the quick reference to cover the core commands, got ${documented.length}`);
    const real = cliCommands();
    for (const cmd of documented) {
      assert.ok(real.has(cmd), `SKILL.md documents 'apitap ${cmd}', which src/cli.ts does not dispatch`);
    }
  });

  it('covers the cold-start path and the replay path', () => {
    const documented = new Set(documentedCommands(readSkill()));
    for (const cmd of ['peek', 'read', 'discover', 'import', 'search', 'show', 'replay', 'browse', 'capture', 'list', 'stats']) {
      assert.ok(documented.has(cmd), `quick reference is missing 'apitap ${cmd}'`);
    }
  });

  it('leads with the no-browser path, not capture', () => {
    const body = readSkill();
    const firstRead = body.indexOf('apitap read');
    const firstCapture = body.indexOf('apitap capture');
    assert.ok(firstRead > -1 && firstCapture > -1);
    assert.ok(firstRead < firstCapture, 'capture must not appear before read');
  });

  it('states the package floor and the browser prerequisite', () => {
    const body = readSkill();
    assert.match(body, /@apitap\/core/);
    assert.match(body, /2\.2\.0/);
    assert.match(body, /playwright install chromium/);
  });

  // Existence only, not per-command: a flag read by any handler passes. So
  // dropping --max-bytes from replay while read still reads it stays green.
  it('documents flags that actually exist in src/cli.ts', () => {
    const cliSource = readFileSync(cliPath, 'utf8');
    const flags = documentedFlags(readSkill());
    assert.ok(flags.length > 0, 'expected the skill to document at least one --flag');
    for (const flag of flags) {
      const readsFlag = new RegExp(`flags(\\.${flag}\\b|\\[['"]${flag}['"]\\])`);
      assert.ok(
        readsFlag.test(cliSource),
        `SKILL.md documents '--${flag}', which src/cli.ts never reads (flags.${flag} / flags['${flag}'])`,
      );
    }
  });

  it('replay still parses positional key=value arguments, not --params', () => {
    const cliSource = readFileSync(cliPath, 'utf8');
    const fnMatch = cliSource.match(/async function handleReplay\([\s\S]*?\n\}/);
    assert.ok(fnMatch, 'src/cli.ts no longer has a handleReplay function — replay arg parsing needs re-checking');
    const fnBody = fnMatch[0];
    assert.match(
      fnBody,
      /\[\s*domain\s*,\s*endpointId\s*,\s*\.\.\.\s*paramArgs\s*\]\s*=\s*positional/,
      'handleReplay no longer destructures [domain, endpointId, ...paramArgs] from positional args — replay may have moved off positional key=value, but SKILL.md still documents that shape',
    );
    assert.match(
      fnBody,
      /\.indexOf\(['"]=['"]\)/,
      'handleReplay no longer splits params on "=" — replay may have moved off positional key=value, but SKILL.md still documents that shape',
    );
  });
});

// The document's factual claims about runtime behaviour — the class of defect
// that name-only guards above cannot catch. Each test pins one claim to the
// source that makes it true, so the claim fails loudly when the code moves.
describe('hermes skill states behaviour the code actually has', () => {
  const src = (rel: string) => readFileSync(join(repoRoot, 'src', rel), 'utf8');

  it('names MCP tools that the MCP server registers', () => {
    const yamlBlock = readSkill().match(/```yaml\n([\s\S]*?)```/);
    assert.ok(yamlBlock, 'SKILL.md no longer has the MCP config block');
    const documented = [...yamlBlock[1].matchAll(/- (apitap_[a-z_]+)/g)].map((m) => m[1]);
    assert.ok(documented.length > 0, 'MCP block documents no tools');
    const mcpSource = src('mcp.ts');
    for (const tool of documented) {
      assert.ok(
        mcpSource.includes(`'${tool}'`) || mcpSource.includes(`"${tool}"`),
        `SKILL.md's MCP include list names '${tool}', which src/mcp.ts does not register — a Hermes tools.include filter naming a nonexistent tool silently exposes nothing`,
      );
    }
  });

  it('quotes the real signature-expiry window', () => {
    const days = src('skill/store.ts').match(/MAX_SIGNATURE_AGE_DAYS\s*=\s*(\d+)/);
    assert.ok(days, 'MAX_SIGNATURE_AGE_DAYS is gone from src/skill/store.ts');
    assert.ok(
      readSkill().includes(`${days[1]} days`),
      `SKILL.md must state the real signature expiry (${days[1]} days) — it drifted from src/skill/store.ts`,
    );
  });

  it('only claims browser-free for commands with no browser dependency', () => {
    // SKILL.md names the browser-driving commands and lists the rest as
    // never launching one. Checking for a `playwright` import is not enough:
    // nothing in this repo launches a browser that way. auth/refresh.ts and
    // auth/handoff.ts both do it via `launchBrowser` from capture/browser.js,
    // which is the module that imports playwright (dynamically, at that). So
    // guard the real entry points, not the library name.
    // auth/refresh.js is on this list because it is how replay/engine.ts
    // acquired its browser path — the drift that round 3 caught.
    // NOT statically guardable: browse.ts could become browser-capable by
    // passing an authManager into its existing replayEndpoint call, with no
    // new import to detect. If that changes, this guard will not tell you.
    const browserEntryPoints = /from ['"].*capture\/(browser|monitor|session)\.js['"]|from ['"].*auth\/(refresh|handoff)\.js['"]|launchBrowser|refreshTokens|requestAuth|from ['"]playwright['"]/;
    for (const rel of ['read/index.ts', 'read/peek.ts', 'orchestration/browse.ts', 'discovery/index.ts']) {
      assert.ok(
        !browserEntryPoints.test(src(rel)),
        `src/${rel} now reaches a browser entry point — SKILL.md lists that path as never launching a browser`,
      );
    }
  });

  it('states the condition that actually gates the browser refresh', () => {
    // SKILL.md's load-bearing conditional: replay opens a browser only when
    // the skill file declares refreshable tokens or a refresh URL. That is
    // one expression in auth/refresh.ts; if it grows a third term, the
    // document's condition is incomplete.
    const needsBrowser = src('auth/refresh.ts').match(/const needsBrowser = ([^;]+);/);
    assert.ok(needsBrowser, 'auth/refresh.ts no longer computes needsBrowser — the replay caveat condition needs re-deriving');
    // Equality, not a substring match: an added term must fail, and a
    // contains-check would happily pass `somethingElse || <expected>`.
    assert.equal(
      needsBrowser[1].replace(/\s+/g, ' ').trim(),
      'tokenNames.size > 0 || (skill.auth?.refreshUrl && !oauthRefreshed)',
      `the browser-refresh condition changed to \`${needsBrowser[1].trim()}\` — SKILL.md says it is "refreshable tokens or a refresh URL"`,
    );
  });

  it('keeps the replay-may-open-a-browser caveat while replay can refresh', () => {
    // replay is deliberately NOT in the browser-free list above: engine.ts
    // calls refreshTokens, which launches Playwright when a skill file
    // declares refreshable tokens or a refresh URL. The document has to keep
    // saying so for as long as that call exists.
    const engine = src('replay/engine.ts');
    const canRefresh = /from ['"]\.\.\/auth\/refresh\.js['"]/.test(engine) && /refreshTokens\(/.test(engine);
    const body = readSkill();
    if (canRefresh) {
      assert.match(
        body,
        /re-mint expired/,
        'replay/engine.ts still calls refreshTokens (which can launch a browser) but SKILL.md dropped the caveat that replay may open one',
      );
    } else {
      assert.fail(
        'replay/engine.ts no longer imports refreshTokens — replay may now be unconditionally browser-free, so SKILL.md can drop its caveat and this guard should be revisited',
      );
    }
  });

  it('warns about capture blocking, for as long as capture blocks', () => {
    const monitor = src('capture/monitor.ts');
    const blocksOnSigint = /else\s*\{\s*await new Promise<void>\(resolve => \{\s*process\.once\('SIGINT', resolve\);/.test(monitor);
    assert.ok(
      blocksOnSigint,
      'capture no longer waits indefinitely on SIGINT — SKILL.md still tells agents --duration is mandatory, so re-check that warning',
    );
    assert.match(
      readSkill(),
      /--duration\b/,
      'capture blocks until SIGINT without --duration, but SKILL.md never documents --duration',
    );
  });

  it('confines the auth_required string to the commands that emit it', () => {
    // SKILL.md tells agents peek reports auth_required and replay does not.
    assert.match(src('read/peek.ts'), /'auth_required'/, "peek no longer emits 'auth_required' — SKILL.md says it does");
    assert.ok(
      !/'auth_required'/.test(src('replay/engine.ts')),
      "replay/engine.ts now emits 'auth_required' — SKILL.md tells agents replay reports 'Authentication required' instead",
    );
    assert.match(
      src('replay/engine.ts'),
      /'Authentication required'/,
      "replay no longer returns 'Authentication required' — SKILL.md quotes that string verbatim",
    );
  });

  it('keeps index build outside the --json contract', () => {
    const cliSource = readFileSync(cliPath, 'utf8');
    const fnMatch = cliSource.match(/async function handleIndex\([\s\S]*?\n\}/);
    assert.ok(fnMatch, 'src/cli.ts no longer has handleIndex');
    assert.ok(
      !/flags(\.json\b|\[['"]json['"]\])/.test(fnMatch[0]),
      'handleIndex now reads a json flag — SKILL.md documents `apitap index build` as the one command with no --json mode',
    );
  });
});

describe('README documents the Hermes install', () => {
  const readme = () => readFileSync(join(repoRoot, 'README.md'), 'utf8');

  it('has a Use with Hermes section', () => {
    assert.match(readme(), /^## Use with Hermes$/m);
  });

  it('gives the GitHub identifier form first, then the raw URL form', () => {
    const body = readme();
    const identifier = body.indexOf('hermes skills install n1byn1kt/apitap/skills/hermes/apitap');
    const rawUrl = body.indexOf('https://raw.githubusercontent.com/n1byn1kt/apitap/main/skills/hermes/apitap/SKILL.md');
    assert.ok(identifier > -1, 'missing the GitHub identifier install form');
    assert.ok(rawUrl > -1, 'missing the raw URL install form');
    assert.ok(identifier < rawUrl, 'the GitHub identifier form carries provenance — document it first');
  });

  it('points at a path that exists in the repo', () => {
    assert.ok(existsSync(skillPath));
  });
});
