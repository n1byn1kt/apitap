import { SkillGenerator } from '../../src/skill/generator.js';
import type { SkillFile } from '../../src/types.js';

export class DomainGeneratorMap {
  private generators = new Map<string, SkillGenerator>();

  getOrCreate(domain: string): SkillGenerator {
    let gen = this.generators.get(domain);
    if (!gen) {
      gen = new SkillGenerator();
      this.generators.set(domain, gen);
    }
    return gen;
  }

  get domains(): string[] {
    return [...this.generators.keys()];
  }

  get totalEndpoints(): number {
    let total = 0;
    for (const gen of this.generators.values()) {
      total += gen.endpointCount;
    }
    return total;
  }

  toSkillFiles(totalRequests?: number): SkillFile[] {
    return this.domains.map(domain => {
      const gen = this.generators.get(domain)!;
      return gen.toSkillFile(domain, { totalRequests });
    });
  }

  clear() {
    this.generators.clear();
  }
}
