// src/capture/body-variables.ts

// Strategy 2: Name-based heuristics — keys implying dynamic values
const DYNAMIC_KEY_PATTERNS = [
  // Time
  /timestamp/i, /\btime\b/i, /\bdate\b/i, /created[_-]?at/i, /updated[_-]?at/i,
  /\bsince\b/i, /\buntil\b/i, /\bbefore\b/i, /\bafter\b/i, /\bexpires?\b/i,
  // Pagination
  /\bcursor\b/i, /\boffset\b/i, /\bpage\b/i, /page[_-]?number/i,
  /next[_-]?token/i, /continuation/i,
  // Identity
  /request[_-]?id/i, /correlation[_-]?id/i, /trace[_-]?id/i,
  /\bnonce\b/i, /idempotency[_-]?key/i,
  // Session
  /session[_-]?id/i, /\bcsrf\b/i, /\bxsrf\b/i,
  // Geolocation
  /\bgeo(code|loc(ation)?)\b/i, /\blat(itude)?\b/i, /\blo?ng(itude)?\b/i,
  /\bcoord/i, /\bzip\b/i, /\bpostal/i,
  // Search / user input
  /\bquery\b/i, /\bsearch/i, /\bkeyword/i, /\bterm\b/i, /\bfilter\b/i,
];

function isDynamicKeyName(key: string): boolean {
  return DYNAMIC_KEY_PATTERNS.some(p => p.test(key));
}

// Strategy 3: Pattern-based detection — value patterns implying dynamic data
function isTimestampOrPattern(value: string | number): boolean {
  if (typeof value === 'number') {
    // Unix epoch seconds (roughly 2001–2603)
    if (Number.isInteger(value) && value >= 1e9 && value < 2e10) return true;
    // Unix epoch milliseconds
    if (Number.isInteger(value) && value >= 1e12 && value < 2e13) return true;
    return false;
  }

  // ISO 8601 datetime
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return true;
  // ISO 8601 date only
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return true;
  // Prefixed IDs (req_xxx, id_xxx, txn_xxx, msg_xxx, evt_xxx)
  if (/^(req|id|txn|msg|evt)_[a-zA-Z0-9]+$/.test(value)) return true;

  return false;
}

/**
 * Detect which fields in a JSON body are likely dynamic variables.
 * Uses three strategies:
 *   Strategy 1 (cross-request diffing) is in body-diff.ts
 *   Strategy 2: Name-based key heuristics
 *   Strategy 3: Pattern-based value detection
 *   Plus existing: numeric values, UUIDs, base64 cursors, numeric strings
 */
export function detectBodyVariables(
  body: unknown,
  prefix = '',
): string[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return [];
  }

  const detected: string[] = [];
  const obj = body as Record<string, unknown>;

  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;

    // Strategy 2: key name implies dynamic value
    if (isDynamicKeyName(key) && value != null) {
      detected.push(path);
      continue;
    }

    if (typeof value === 'number') {
      // Strategy 3: epoch timestamp detection
      if (isTimestampOrPattern(value)) {
        detected.push(path);
      } else {
        // Original: numeric values are often IDs
        detected.push(path);
      }
    } else if (typeof value === 'string') {
      // Strategy 3: timestamp/pattern detection (checked first, catches more)
      if (isTimestampOrPattern(value)) {
        detected.push(path);
      } else if (isLikelyDynamic(value)) {
        detected.push(path);
      }
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      // Recurse into nested objects
      detected.push(...detectBodyVariables(value, path));
    }
  }

  return detected;
}

function isLikelyDynamic(value: string): boolean {
  // UUID
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    return true;
  }
  // Base64-ish cursor (long alphanumeric with optional padding)
  if (value.length > 15 && /^[a-zA-Z0-9+/=_-]+$/.test(value)) {
    return true;
  }
  // Numeric string (ID)
  if (/^\d{4,}$/.test(value)) {
    return true;
  }
  return false;
}

/**
 * Substitute variables in a body template.
 */
export function substituteBodyVariables(
  template: string | Record<string, unknown>,
  values: Record<string, string>,
): string | Record<string, unknown> {
  if (typeof template === 'string') {
    // String template with :param placeholders
    return template.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (match, name) => {
      return values[name] ?? match;
    });
  }

  // Deep clone and substitute
  const result = JSON.parse(JSON.stringify(template)) as Record<string, unknown>;

  for (const [path, value] of Object.entries(values)) {
    setNestedValue(result, path, value);
  }

  return result;
}

function setNestedValue(obj: Record<string, unknown>, path: string, value: string): void {
  const parts = path.split('.');
  let current = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (current[part] && typeof current[part] === 'object') {
      current = current[part] as Record<string, unknown>;
    } else {
      return; // Path doesn't exist
    }
  }

  const lastPart = parts[parts.length - 1];
  if (lastPart in current) {
    current[lastPart] = value;
  }
}
