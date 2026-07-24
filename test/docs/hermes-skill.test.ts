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
    assert.equal(fm.version, '1.0.0');
    assert.equal(fm.license, 'Apache-2.0');
    assert.equal(fm.author, 'ApiTap Contributors');
    assert.deepEqual(fm.platforms, ['linux', 'macos', 'windows']);
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
    const invisible = /[​-‍⁠⁢-⁤﻿‪-‮⁦-⁩]/;
    assert.ok(!invisible.test(readSkill()));
  });
});

const cliPath = join(repoRoot, 'src', 'cli.ts');

/** Commands the real CLI dispatches on, parsed from its switch statement. */
function cliCommands(): Set<string> {
  const source = readFileSync(cliPath, 'utf8');
  const found = new Set([...source.matchAll(/^\s*case '([a-z][a-z-]*)':/gm)].map((m) => m[1]));
  // Sanity-check the parse itself before trusting it as an oracle.
  for (const anchor of ['read', 'peek', 'replay', 'capture', 'browse']) {
    assert.ok(found.has(anchor), `CLI parse looks wrong — no case for '${anchor}'`);
  }
  return found;
}

/** Every `apitap <cmd>` that appears in a code span or fenced code block. */
function documentedCommands(source: string): string[] {
  const codeChunks = [
    ...[...source.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]),
    ...[...source.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]),
  ];
  const commands = new Set<string>();
  for (const chunk of codeChunks) {
    for (const match of chunk.matchAll(/\bapitap ([a-z][a-z-]*)/g)) commands.add(match[1]);
  }
  return [...commands].sort();
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
