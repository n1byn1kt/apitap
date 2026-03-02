export function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function pickPrimaryDomain(domains: string[]): string | null {
  if (domains.length === 0) return null;
  const counts = new Map<string, number>();
  for (const d of domains) {
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  let best = domains[0];
  let bestCount = 0;
  // Iterate in insertion order — first-seen wins on tie
  for (const [domain, count] of counts) {
    if (count > bestCount) {
      best = domain;
      bestCount = count;
    }
  }
  return best;
}
