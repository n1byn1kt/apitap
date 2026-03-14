// src/capture/parameterize.ts

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PURE_NUMERIC_RE = /^\d+$/;
const LONG_DIGITS_RE = /\d{8,}/;
const LONG_HEX_RE = /^[0-9a-f]{16,}$/i;
const NEXT_DATA_PREFIX_RE = /^\/_next\/data\/[^/]+\//;

/**
 * Resource nouns: segments that name a collection of resources.
 * The value is the param name(s) for the slot(s) that follow.
 * e.g. "repos" expects two dynamic segments: :owner/:repo
 */
const RESOURCE_NOUNS = new Map<string, string[]>([
  // Code hosting / generic REST
  ['repos',         [':owner', ':repo']],
  ['users',         [':username']],
  ['orgs',          [':org']],
  ['organizations', [':org']],
  ['teams',         [':team']],
  ['members',       [':member']],
  ['projects',      [':project']],
  ['gists',         [':gist_id']],
  ['issues',        [':issue_number']],
  ['pulls',         [':pull_number']],
  ['commits',       [':sha']],
  ['branches',      [':branch']],
  ['tags',          [':tag']],
  ['releases',      [':release_id']],
  ['milestones',    [':milestone']],
  ['labels',        [':label']],
  ['hooks',         [':hook_id']],
  ['keys',          [':key_id']],
  ['deployments',   [':deployment_id']],
  ['environments',  [':env']],
  ['runs',          [':run_id']],
  ['jobs',          [':job_id']],
  ['artifacts',     [':artifact_id']],
  ['packages',      [':package']],

  // Content / social
  ['posts',         [':post_id']],
  ['comments',      [':comment_id']],
  ['articles',      [':article_id']],
  ['stories',       [':story_id']],
  ['threads',       [':thread_id']],
  ['messages',      [':message_id']],
  ['channels',      [':channel']],
  ['videos',        [':video_id']],
  ['playlists',     [':playlist_id']],
  ['tracks',        [':track_id']],
  ['albums',        [':album_id']],
  ['artists',       [':artist_id']],
  ['images',        [':image_id']],
  ['files',         [':file_id']],
  ['documents',     [':doc_id']],
  ['folders',       [':folder_id']],
  ['collections',   [':collection_id']],
  ['categories',    [':category']],

  // E-commerce
  ['products',      [':product_id']],
  ['items',         [':item_id']],
  ['orders',        [':order_id']],
  ['customers',     [':customer_id']],
  ['carts',         [':cart_id']],
  ['stores',        [':store_id']],
  ['reviews',       [':review_id']],

  // Infrastructure / ops
  ['accounts',      [':account_id']],
  ['workspaces',    [':workspace']],
  ['databases',     [':database']],
  ['tables',        [':table']],
  ['namespaces',    [':namespace']],
  ['clusters',      [':cluster']],
  ['instances',     [':instance']],
  ['regions',       [':region']],
  ['zones',         [':zone']],
  ['resources',     [':resource_id']],
  ['subscriptions', [':subscription_id']],
  ['tenants',       [':tenant_id']],
  ['groups',        [':group_id']],
  ['roles',         [':role']],
  ['policies',      [':policy']],
  ['tokens',        [':token_id']],
  ['sessions',      [':session_id']],
  ['events',        [':event_id']],
  ['logs',          [':log_id']],
  ['metrics',       [':metric']],
  ['alerts',        [':alert_id']],
  ['notifications', [':notification_id']],
  ['webhooks',      [':webhook_id']],

  // Media
  ['media',         [':media_id']],
  ['assets',        [':asset_id']],
  ['uploads',       [':upload_id']],
]);

/**
 * Segments that are always structural (never parameterized).
 * Includes version prefixes, action verbs, and all RESOURCE_NOUNS keys.
 */
const STRUCTURAL_SEGMENTS = new Set<string>([
  // Version prefixes
  'api', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8', 'v9', 'v10',
  // Actions / sub-resources
  'search', 'filter', 'sort', 'query', 'list', 'create', 'update', 'delete',
  'status', 'config', 'settings', 'preferences', 'profile', 'info', 'details',
  'stats', 'analytics', 'count', 'batch', 'bulk', 'export', 'import',
  'auth', 'login', 'logout', 'register', 'signup', 'signin', 'callback',
  'oauth', 'token', 'refresh', 'verify', 'confirm', 'reset', 'activate',
  'public', 'private', 'internal', 'external', 'admin', 'management',
  'graphql', 'gql', 'rest', 'rpc', 'ws', 'websocket', 'stream', 'feed',
  'health', 'ping', 'version', 'manifest', 'metadata', 'schema',
  'upload', 'download', 'preview', 'thumbnail', 'embed',
  'latest', 'trending', 'popular', 'featured', 'recommended', 'top', 'new',
  'web', 'app', 'mobile', 'desktop', 'data', 'raw', 'render',
  'consent', 'wrapper', 'widget', 'integrity', 'pathfinder', 'rum',
  // All resource noun keys are also structural
  ...RESOURCE_NOUNS.keys(),
]);

/**
 * Check if a path segment is a dynamic value based on its structure alone.
 * Returns the parameter name (:id, :hash, :slug) or null if static.
 */
function classifySegment(segment: string): string | null {
  // Pure numeric → :id
  if (PURE_NUMERIC_RE.test(segment)) return ':id';

  // UUID → :id
  if (UUID_RE.test(segment)) return ':id';

  // Long hex string (16+ hex chars) → :hash
  if (LONG_HEX_RE.test(segment)) return ':hash';

  // Slug with embedded long number (8+ consecutive digits) — check before hash
  // because slugs like "btc-updown-15m-1770254100" would also match the hash rule
  if (LONG_DIGITS_RE.test(segment)) {
    return ':slug';
  }

  // Strip hyphens/underscores for character analysis
  const stripped = segment.replace(/[-_]/g, '');

  // Hash-like: 12+ alphanumeric chars with both letters and digits
  if (stripped.length >= 12 && /[a-zA-Z]/.test(stripped) && /\d/.test(stripped)) {
    return ':hash';
  }

  return null;
}

/**
 * Check if a segment looks like a lowercase word or hyphenated compound word.
 * e.g. "search", "location-metadata", "top-rated" → true
 * e.g. "n1byn1kt", "OxItOzEC", "ABC-123" → false
 */
function looksLikeWord(segment: string): boolean {
  return /^[a-z][a-z-]*[a-z]$/.test(segment)
    && segment.split('-').every(part => /^[a-z]{2,}$/.test(part));
}

/**
 * Replace dynamic path segments with named :param placeholders.
 *
 * Three-layer approach:
 * 1. Structural detection: UUIDs, numbers, hashes, long-digit slugs
 * 2. Context-aware: segments following a known resource noun get a
 *    semantically named param (e.g. /repos/:owner/:repo)
 * 3. Heuristic fallback: non-word segments after structural segments
 *    are parameterized as :id
 */
export function parameterizePath(path: string): string {
  const segments = path.split('/');
  const result: string[] = [];
  let nounSlots: string[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];

    // Preserve empty segments (leading/trailing slashes)
    if (seg === '') { result.push(seg); continue; }

    const lower = seg.toLowerCase();

    // Layer 1: Always parameterize structurally obvious dynamic values
    // Order matters: pure numeric before long-digits (1770254100 is numeric, not a slug)
    if (UUID_RE.test(seg)) { result.push(':id'); nounSlots = []; continue; }

    if (PURE_NUMERIC_RE.test(seg)) {
      // Use noun-derived name if available, otherwise :id
      const name = nounSlots.length > 0 ? nounSlots.shift()! : ':id';
      result.push(name);
      continue;
    }

    if (LONG_HEX_RE.test(seg)) { result.push(':hash'); nounSlots = []; continue; }

    // Slug with embedded long number (8+ digits mixed with text)
    // Pure-numeric already handled above, so this only fires on mixed segments
    if (LONG_DIGITS_RE.test(seg)) { result.push(':slug'); nounSlots = []; continue; }

    // Hash-like: 12+ mixed alphanum (catches remaining patterns)
    const structural = classifySegment(seg);
    if (structural) { result.push(structural); nounSlots = []; continue; }

    // Layer 2: Known resource noun → keep it, queue param names for following segments
    if (RESOURCE_NOUNS.has(lower)) {
      result.push(seg);
      nounSlots = [...RESOURCE_NOUNS.get(lower)!];
      continue;
    }

    // Structural segment → keep as-is, reset slots
    if (STRUCTURAL_SEGMENTS.has(lower)) {
      result.push(seg);
      nounSlots = [];
      continue;
    }

    // Fill a queued noun slot (e.g. "n1byn1kt" after "repos")
    if (nounSlots.length > 0) {
      result.push(nounSlots.shift()!);
      continue;
    }

    // Layer 3: Heuristic — segment after a structural segment that doesn't
    // look like a plain English word is likely a dynamic value
    const prevSeg = i > 0 ? segments[i - 1]?.toLowerCase() : '';
    const prevIsStructural = STRUCTURAL_SEGMENTS.has(prevSeg) || RESOURCE_NOUNS.has(prevSeg);

    if (prevIsStructural && seg.length >= 2 && !looksLikeWord(seg)) {
      result.push(':id');
      continue;
    }

    // Default: keep as-is
    result.push(seg);
    nounSlots = [];
  }

  return result.join('/');
}

/**
 * Strip framework-specific path noise for clean endpoint IDs.
 *
 * - Strips /_next/data/<hash>/ prefix (Next.js data routes)
 * - Strips .json suffix
 */
export function cleanFrameworkPath(path: string): string {
  let cleaned = path;
  // Strip _next/data/<hash>/ prefix
  cleaned = cleaned.replace(NEXT_DATA_PREFIX_RE, '/');
  // Strip .json suffix
  cleaned = cleaned.replace(/\.json$/, '');
  // Ensure we have at least /
  return cleaned || '/';
}
