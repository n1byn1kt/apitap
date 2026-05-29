// src/known-specs-loader.ts
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

export interface KnownSpec {
  provider: string;
  repo: string;
  specPath: string;
  specUrl: string;
  notes: string;
}

export function loadKnownSpecs(): KnownSpec[] {
  // __dirname is not defined in ESM; derive it from import.meta.url.
  // fileURLToPath (not URL.pathname) handles Windows drive paths and
  // percent-encoded characters (spaces etc.) in the install path correctly.
  const here = dirname(fileURLToPath(import.meta.url));
  const specPath = join(here, '../data/known-specs.json');
  return JSON.parse(readFileSync(specPath, 'utf-8')) as KnownSpec[];
}
