// src/capture/body-diff.ts

/**
 * Cross-request body diffing (Strategy 1).
 *
 * Compare request bodies across multiple captures of the same endpoint.
 * Any field whose value changed between requests is dynamic by definition.
 * Returns JSON paths of changed fields.
 */
export function diffBodies(bodies: string[]): string[] {
  if (bodies.length < 2) return [];

  // Try JSON first
  const parsed: unknown[] = [];
  for (const body of bodies) {
    try {
      parsed.push(JSON.parse(body));
    } catch {
      // Fall back to form-encoded diffing
      return diffFormEncoded(bodies);
    }
  }

  // All parsed as JSON — diff objects
  const changed = new Set<string>();
  for (let i = 1; i < parsed.length; i++) {
    diffObjects(parsed[0], parsed[i], '', changed);
  }
  return [...changed].sort();
}

function diffObjects(a: unknown, b: unknown, prefix: string, changed: Set<string>): void {
  // Different types → the whole path is dynamic
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b)) {
    if (prefix) changed.add(prefix);
    return;
  }

  // Both arrays
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      // Different lengths → mark whole array as dynamic
      if (prefix) changed.add(prefix);
      return;
    }
    for (let i = 0; i < a.length; i++) {
      diffObjects(a[i], b[i], prefix ? `${prefix}[${i}]` : `[${i}]`, changed);
    }
    return;
  }

  // Both objects
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a)) {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const allKeys = new Set([...Object.keys(aObj), ...Object.keys(bObj)]);

    for (const key of allKeys) {
      const path = prefix ? `${prefix}.${key}` : key;

      if (!(key in aObj) || !(key in bObj)) {
        // Key only exists in one → dynamic
        changed.add(path);
      } else {
        diffObjects(aObj[key], bObj[key], path, changed);
      }
    }
    return;
  }

  // Primitive comparison
  if (a !== b && prefix) {
    changed.add(prefix);
  }
}

function diffFormEncoded(bodies: string[]): string[] {
  const parsed = bodies.map(parseFormEncoded);
  if (parsed.some(m => m.size === 0)) return [];

  const changed = new Set<string>();
  const firstMap = parsed[0];

  for (let i = 1; i < parsed.length; i++) {
    const otherMap = parsed[i];
    const allKeys = new Set([...firstMap.keys(), ...otherMap.keys()]);

    for (const key of allKeys) {
      if (firstMap.get(key) !== otherMap.get(key)) {
        changed.add(key);
      }
    }
  }

  return [...changed].sort();
}

function parseFormEncoded(body: string): Map<string, string> {
  const map = new Map<string, string>();
  const pairs = body.split('&');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const key = decodeURIComponent(pair.slice(0, idx).replace(/\+/g, ' '));
    const val = decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, ' '));
    map.set(key, val);
  }
  return map;
}
