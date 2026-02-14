import type { SkillFile } from '../types.js';

export interface CacheEntry {
  domain: string;
  skillFile: SkillFile;
  discoveredAt: number;
  source: 'disk' | 'discovered' | 'captured';
}

export class SessionCache {
  private entries = new Map<string, CacheEntry>();

  set(domain: string, skillFile: SkillFile, source: CacheEntry['source']): void {
    this.entries.set(domain, {
      domain,
      skillFile,
      discoveredAt: Date.now(),
      source,
    });
  }

  get(domain: string): CacheEntry | null {
    return this.entries.get(domain) ?? null;
  }

  has(domain: string): boolean {
    return this.entries.has(domain);
  }

  invalidate(domain: string): void {
    this.entries.delete(domain);
  }

  domains(): string[] {
    return [...this.entries.keys()];
  }
}
