// src/known-specs-loader.ts
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

export interface KnownSpec {
  provider: string;
  repo: string;
  specPath: string;
  specUrl: string;
  notes: string;
}

export function loadKnownSpecs(): KnownSpec[] {
  // __dirname is not defined in ESM; use import.meta.url
  const specPath = join(new URL('.', import.meta.url).pathname, '../data/known-specs.json');
  return JSON.parse(readFileSync(specPath, 'utf-8')) as KnownSpec[];
}
