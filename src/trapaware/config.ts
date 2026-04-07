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

// In-process cache keyed by resolved config path. The first call per path
// reads the file (or catches ENOENT and stores defaults); subsequent calls
// return the cached value without a syscall. This matters for the cron-job
// replay path, where a user without a config file would otherwise trigger
// one failed readFile per replay.
//
// Keying by path means tests that override XDG_CONFIG_HOME per-test see a
// different cache key and naturally re-read. Config changes mid-process are
// not observed — acceptable for cron jobs (short-lived) and interactive
// users can restart the process.
const configCache = new Map<string, TrapAwareConfig>();

export async function loadTrapAwareConfig(): Promise<TrapAwareConfig> {
  const path = getConfigPath();
  const cached = configCache.get(path);
  if (cached !== undefined) {
    return { ...cached };
  }

  let value: TrapAwareConfig;
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    // File does not exist, or unreadable — use defaults.
    value = { ...DEFAULT_CONFIG };
    configCache.set(path, { ...value });
    return value;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.stderr.write(
      `apitap: ignoring malformed config at ${path}, using defaults\n`,
    );
    value = { ...DEFAULT_CONFIG };
    configCache.set(path, { ...value });
    return value;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    value = { ...DEFAULT_CONFIG };
    configCache.set(path, { ...value });
    return value;
  }

  const obj = parsed as Record<string, unknown>;
  value = {
    egressCheckAll: obj.egressCheckAll === true,
    egressCheckAction: sanitizeAction(obj.egressCheckAction),
  };
  configCache.set(path, { ...value });
  return value;
}
