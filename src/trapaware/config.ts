// src/trapaware/config.ts
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { TrapAwareConfig } from './types.js';

const DEFAULT_CONFIG: TrapAwareConfig = Object.freeze({
  egressCheckAll: false,
  egressCheckAction: 'annotate',
});

function xdgConfigHome(): string {
  return process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
}

export function getConfigPath(): string {
  return join(xdgConfigHome(), 'apitap', 'config.json');
}

function sanitizeAction(raw: unknown): 'annotate' | 'block' {
  return raw === 'block' ? 'block' : 'annotate';
}

export async function loadTrapAwareConfig(): Promise<TrapAwareConfig> {
  const path = getConfigPath();
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err: unknown) {
    // File does not exist, or unreadable — return defaults.
    return { ...DEFAULT_CONFIG };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.stderr.write(
      `apitap: ignoring malformed config at ${path}, using defaults\n`,
    );
    return { ...DEFAULT_CONFIG };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ...DEFAULT_CONFIG };
  }
  const obj = parsed as Record<string, unknown>;
  return {
    egressCheckAll: obj.egressCheckAll === true,
    egressCheckAction: sanitizeAction(obj.egressCheckAction),
  };
}
