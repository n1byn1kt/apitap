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
