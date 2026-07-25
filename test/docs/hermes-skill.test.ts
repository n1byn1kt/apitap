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
    // Only apitap's own flags. The document also shows flags belonging to
    // other tools (Chrome's --remote-debugging-port, npx playwright), and
    // src/cli.ts is not the authority on those.
    if (/\b(?:npx|google-chrome|chrome)\b/.test(chunk)) continue;
    if (/--remote-debugging-port/.test(chunk)) continue;
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

  it('never lists a browser-driving command as one that never launches one', () => {
    // Guards the document's own list, which the module-scanning test below
    // cannot see: if someone adds capture/inspect/refresh/attach/replay to the
    // "These never launch one" sentence, that is a false claim regardless of
    // what any src/ module imports.
    const neverLaunch = readSkill().match(/These never launch one:([\s\S]*?)\n\n/);
    assert.ok(neverLaunch, 'SKILL.md no longer carries the "These never launch one" list');
    for (const cmd of ['capture', 'inspect', 'refresh', 'attach', 'replay']) {
      assert.ok(
        !new RegExp(`\`apitap ${cmd}\``).test(neverLaunch[1]),
        `SKILL.md lists 'apitap ${cmd}' as never launching a browser, but it can`,
      );
    }
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
    // The list mirrors SKILL.md's "never launch one" claim: read/peek/browse/
    // discovery are the data paths, and search/store/importer/stats back the
    // search, list, show, import and stats commands (their cli.ts handlers
    // only shuffle output). cli.ts itself cannot be scanned this way — it
    // legitimately reaches capture for the browser-driving commands.
    for (const rel of [
      'read/index.ts', 'read/peek.ts', 'orchestration/browse.ts', 'discovery/index.ts',
      'skill/search.ts', 'skill/store.ts', 'skill/importer.ts', 'stats/report.ts',
    ]) {
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
      // Pin the CONDITION, not a phrase. An earlier version of this guard
      // required the words "re-mint expired", which locked in wording that
      // was itself wrong — expiry is only one of three triggers.
      assert.match(
        body,
        /refreshable tokens/,
        'replay/engine.ts still calls refreshTokens (which can launch a browser) but SKILL.md no longer states the refreshable-tokens condition that gates it',
      );
      for (const trigger of ['--fresh', '401/403', 'expired']) {
        assert.ok(
          body.includes(trigger),
          `SKILL.md no longer names '${trigger}' as a replay refresh trigger, but engine.ts still refreshes on it`,
        );
      }
      // Both disjuncts of needsBrowser must survive in the prose, not just
      // the first: a reader who only learns about refreshable tokens will
      // wrongly conclude a refreshUrl-only skill file is browser-free.
      assert.match(
        body,
        /refresh URL/,
        'SKILL.md dropped the refresh-URL half of the browser-refresh condition, but needsBrowser still tests skill.auth?.refreshUrl',
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
    // /--duration\b/ alone is satisfied by the Quick Reference command table,
    // so pin the load-bearing warning sentences themselves.
    assert.match(
      readSkill(),
      /\*\*Always pass `--duration`\*\*/,
      'capture blocks until SIGINT without --duration, but SKILL.md dropped the "Always pass --duration" warning',
    );
    assert.match(
      readSkill(),
      /`--duration` is not optional in practice/,
      'capture blocks until SIGINT without --duration, but SKILL.md dropped the "not optional in practice" explanation',
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

  it('ties the capture sign-in advice to the DISPLAY switch that governs it', () => {
    // Scope: the browser capture LAUNCHES is headless unless DISPLAY is set,
    // with no CLI override — which is why the doc limits that route to a
    // Linux desktop. The CDP-attach route bypasses this switch entirely and
    // is guarded separately below.
    const monitor = src('capture/monitor.ts');
    assert.match(
      monitor,
      /headless:\s*options\.headless \?\? \(process\.env\.DISPLAY \? false : true\)/,
      'capture no longer keys headless off DISPLAY — SKILL.md limits the manual sign-in route on exactly that basis',
    );
    assert.ok(
      !/flags\.head(ed|less)|flags\[['"]head(ed|less)['"]\]/.test(readFileSync(cliPath, 'utf8')),
      'the CLI gained a headed/headless flag — SKILL.md says there is none, so the sign-in advice can be widened',
    );
    assert.match(
      readSkill(),
      /DISPLAY/,
      'SKILL.md no longer explains the DISPLAY condition that decides whether a human can sign in to capture',
    );
    // The other route: capture joins an already-running Chrome over CDP
    // before it ever launches one, which is what makes a manual sign-in
    // possible on macOS. Over-narrowing the advice to Linux was a real
    // defect, so keep the attach route in the document.
    assert.match(
      monitor,
      /if \(!options\.launch\) \{[\s\S]*?connectOverCDP/,
      'capture no longer tries CDP attach before launching — SKILL.md tells agents that route works on any platform',
    );
    assert.match(
      readSkill(),
      /remote-debugging-port/,
      'SKILL.md dropped the CDP-attach sign-in route, which is the only one that works on macOS',
    );
  });

  it('warns about equals-form flags for as long as the parser drops them', () => {
    // Load-bearing: `--duration=30` being silently dropped puts capture back
    // in the indefinite SIGINT wait while the agent believes it passed the
    // flag. parseArgs is not exported, so pin its shape instead.
    const cliSource = readFileSync(cliPath, 'utf8');
    const parser = cliSource.match(/function parseArgs\([\s\S]*?\n\}/);
    assert.ok(parser, 'src/cli.ts no longer has parseArgs — re-derive the flag-form warning');
    // The warning is true exactly while parseArgs takes the whole token after
    // `--` as the key and never inspects '='. Pin both halves: the slice(2)
    // key extraction, and the absence of '=' from every string or regex
    // literal in the function (split('='), includes('='), /--([^=]+)=/ and
    // friends would all show up there).
    assert.ok(
      parser[0].includes('rest[i].slice(2)'),
      'parseArgs no longer takes the whole token as the flag key — re-verify whether --flag=value is still dropped',
    );
    const literals = parser[0].match(/'[^'\n]*'|"[^"\n]*"|`[^`\n]*`|\/[^/\n ]+\//g) ?? [];
    assert.ok(
      !literals.some(l => l.includes('=')),
      'parseArgs now mentions "=" in a literal — it may understand --flag=value, so re-verify the SKILL.md equals-form warning',
    );
    assert.match(
      readSkill(),
      /never\s+`--max-bytes=50000`/,
      'parseArgs still drops --flag=value, but SKILL.md no longer warns about it',
    );
  });

  it('describes the unreadable-skill-file browse behaviour of the code as built', () => {
    // Post-#75 browse skips an unreadable skill file instead of aborting:
    // readSkillFile's throw is caught into skillFileError, escalation
    // continues, and the guidance carries the field (with reason
    // unreadable_skill_file on the final exit). SKILL.md documents both the
    // 2.2.0 abort and this skip-and-escalate contract; if either side
    // changes, the passage needs re-deriving.
    const browse = src('orchestration/browse.ts');
    // Pin the mechanism, not just the identifier: the catch around
    // readSkillFile is what turns abort-on-unreadable into skip-and-escalate.
    // If the catch goes, `skillFileError` could survive as a dead field while
    // the behaviour reverts.
    assert.match(browse, /catch\s*\([^)]*\)\s*\{[^}]*skillFileError =/,
      'browse.ts no longer catches readSkillFile failures into skillFileError — it may abort on unreadable files again, so re-derive the SKILL.md passage');
    assert.match(browse, /'unreadable_skill_file'/,
      "browse.ts no longer emits reason 'unreadable_skill_file' — SKILL.md still documents it");
    assert.match(browse, /preserveSkillFile/,
      'browse.ts no longer preserves the unreadable file before overwriting — SKILL.md still promises a .quarantine copy');
    // The directory name SKILL.md prints comes from doctor/snapshot.ts.
    assert.match(src('doctor/snapshot.ts'), /QUARANTINE_DIR = '\.quarantine'/,
      "the quarantine directory is no longer '.quarantine' — SKILL.md's ~/.apitap/skills/.quarantine/ path is stale");
    assert.match(readSkill(), /skillFileError/,
      'browse reports skillFileError on skipped files, but SKILL.md never mentions it');
    assert.match(readSkill(), /\.quarantine/,
      'browse preserves skipped files under .quarantine, but SKILL.md never says where');
    // Both halves of the dual-version passage are load-bearing: the abort
    // wording for the npm 2.2.0 release, the skip wording for later builds.
    assert.match(readSkill(), /npm 2\.2\.0 abort browse/,
      'SKILL.md dropped the 2.2.0 abort behaviour — agents on the npm release still hit it');
  });

  it('warns about the discover --json --save double document while it prints one', () => {
    // handleDiscover prints the discovery result, then a second standalone
    // {"saved": path} document when --save actually writes a file. One JSON
    // parse of the whole output fails with "Extra data" — SKILL.md warns
    // about it. If the CLI ever collapses this to a single envelope, the
    // warning becomes false and should go.
    const cliSource = readFileSync(cliPath, 'utf8');
    // Scope to handleDiscover — the same snippet elsewhere in cli.ts must not
    // keep this green — and pin BOTH prints: the warning is only true while
    // the result document AND the {"saved"} document are separate writes.
    const handler = cliSource.match(/async function handleDiscover\([\s\S]*?\n\}/);
    assert.ok(handler, 'src/cli.ts no longer has handleDiscover — re-derive the two-JSON warning');
    assert.match(
      handler[0],
      /console\.log\(JSON\.stringify\(\{ saved: path \}\)\)/,
      'discover --json --save no longer prints a separate {"saved"} document — drop the two-JSON warning from SKILL.md',
    );
    assert.match(
      handler[0],
      /console\.log\(JSON\.stringify\(\{ \.\.\.result/,
      'handleDiscover no longer prints the result as its own document — the SKILL.md two-document warning is stale',
    );
    assert.match(
      readSkill(),
      /\*\*two\*\* JSON documents/,
      'discover --json --save still prints two JSON documents, but SKILL.md no longer warns about it',
    );
  });

  it('warns that browse reports success on a login wall, both ways it can', () => {
    // browse returns success:true for a JSON 401/403 (it only rejects an HTML
    // content-type after replay) and success:true again on the cold-start
    // read fallback, which accepts any non-empty non-spa-shell page including
    // a login form. Agents that trust the flag mistake both for data.
    const browse = src('orchestration/browse.ts');
    const readFallbackSucceeds = /readResult\.content\.trim\(\)\.length > 0 && readResult\.metadata\.source !== 'spa-shell'/.test(browse);
    assert.ok(
      readFallbackSucceeds,
      "browse's read fallback no longer returns success for any non-empty page — re-check what SKILL.md says about login walls",
    );
    // The other success:true path: after a replay, browse rejects only an
    // HTML content-type. If it ever starts rejecting 401/403 too, a JSON
    // login wall stops being reported as success and the doc overwarns.
    const replayStep = browse.match(/\/\/ Step 5: Replay[\s\S]*?return \{\s*success: true/);
    assert.ok(replayStep, 'browse.ts no longer has the Step 5 replay path this warning describes');
    assert.ok(
      !/status === 401|status === 403|status >= 400/.test(replayStep[0]),
      'browse now screens replay status codes — a JSON 401/403 may no longer surface as success:true, so re-check the login-wall warning',
    );
    assert.match(
      readSkill(),
      /"success": true` from browse means "I got\s+something"/,
      'browse still reports success:true for login walls, but SKILL.md dropped the warning',
    );
  });

  it('keeps index build outside the --json SUCCESS contract', () => {
    // Issue #79 brought every command's failure path into the --json contract,
    // `index build` included. What stays true is that its success path prints
    // human text only — so assert on the success path, not on the whole
    // function reading a json flag.
    const cliSource = readFileSync(cliPath, 'utf8');
    const fnMatch = cliSource.match(/async function handleIndex\([\s\S]*?\n\}/);
    assert.ok(fnMatch, 'src/cli.ts no longer has handleIndex');

    // Everything after the argument guard is the success path.
    const successPath = fnMatch[0].slice(fnMatch[0].indexOf('const skillsDir'));
    assert.ok(successPath, 'handleIndex no longer has a skillsDir success path');
    assert.ok(
      !/JSON\.stringify/.test(successPath),
      'handleIndex now emits JSON on success — SKILL.md documents `apitap index build` as having no --json success mode',
    );
  });

  it('documents the --json failure envelope', () => {
    assert.match(
      readSkill(),
      /"success": false, "error"/,
      'SKILL.md must document the --json failure envelope (issue #79)',
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
