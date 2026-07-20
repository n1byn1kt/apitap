// src/read/decoders/lobsters.ts
import type { Decoder, ReadResult } from '../types.js';
import { safeFetch } from '../../discovery/fetch.js';

const DEFAULT_BASE = 'https://lobste.rs';

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export const lobstersDecoder: Decoder = {
  name: 'lobsters',
  patterns: [
    /^https?:\/\/lobste\.rs\/s\/[a-z0-9]+/i,
    /^https?:\/\/lobste\.rs\/?(?:(?:hottest|newest|recent)\/?)?(?:\?|$)/i,
  ],

  async decode(url: string, options: { skipSsrf?: boolean; [key: string]: any } = {}): Promise<ReadResult | null> {
    try {
      const base = options._apiBaseUrl || DEFAULT_BASE;
      const fetchOpts = { skipSsrf: options.skipSsrf };
      const storyMatch = url.match(/lobste\.rs\/s\/([a-z0-9]+)/i);
      if (storyMatch) return await decodeStory(url, storyMatch[1], base, fetchOpts);
      // Explicit path→feed mapping. /recent has no dedicated JSON feed on
      // lobste.rs, so it deliberately maps to hottest.json (same as the
      // bare front page) rather than falling through silently.
      let feed: 'hottest' | 'newest';
      if (/\/newest\/?(?:\?|$)/.test(url)) feed = 'newest';
      else feed = 'hottest'; // covers '/', '/hottest', '/recent'
      return await decodeFront(url, feed, base, fetchOpts);
    } catch {
      return null;
    }
  },
};

async function decodeFront(url: string, feed: string, base: string, fetchOpts: { skipSsrf?: boolean }): Promise<ReadResult | null> {
  const res = await safeFetch(`${base}/${feed}.json`, fetchOpts);
  if (!res || res.status !== 200) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(res.body); } catch { return null; }
  if (!Array.isArray(parsed)) return null;

  // Guard malformed entries (null/non-object/missing title) rather than
  // letting a bad fixture/response throw mid-map — bail to null so the
  // read pipeline falls back to generic HTML extraction.
  const stories = parsed.filter(
    (s): s is Record<string, any> => s != null && typeof s === 'object' && typeof s.title === 'string',
  );
  if (stories.length === 0) return null;

  const top = stories.slice(0, 25);
  const lines = top.map((s, i) => {
    const tags = Array.isArray(s.tags) && s.tags.length ? ` [${s.tags.join(', ')}]` : '';
    return `${i + 1}. ${s.title}${tags}\n   ${s.url || s.comments_url}\n   ${s.score} points | ${s.comment_count} comments | by ${s.submitter_user} | ${s.comments_url}`;
  });
  const content = lines.join('\n\n');
  const feedLabel = feed === 'newest' ? 'Newest' : 'Hottest';

  return {
    url,
    title: `Lobsters — ${feedLabel} Stories`,
    author: null,
    description: `Lobsters ${feedLabel.toLowerCase()} stories (${top.length})`,
    content,
    links: top.map((s) => ({ text: s.title, href: s.url || s.comments_url })),
    images: [],
    metadata: { type: 'listing', publishedAt: null, source: 'lobsters-json', canonical: url, siteName: 'Lobsters' },
    cost: { tokens: estimateTokens(content) },
  };
}

async function decodeStory(url: string, id: string, base: string, fetchOpts: { skipSsrf?: boolean }): Promise<ReadResult | null> {
  const res = await safeFetch(`${base}/s/${id}.json`, fetchOpts);
  if (!res || res.status !== 200) return null;
  let story: any;
  try { story = JSON.parse(res.body); } catch { return null; }
  if (!story?.title) return null;

  const header = `${story.title}\n${story.url || ''}\n${story.score} points | by ${story.submitter_user}\n`;
  const body = story.description_plain ? `\n${story.description_plain}\n` : '';
  const comments = Array.isArray(story.comments)
    ? story.comments.slice(0, 40).map((c: any) => `— ${c.commenting_user}: ${c.comment_plain ?? ''}`).join('\n\n')
    : '';
  const content = `${header}${body}\n${comments}`.trim();

  return {
    url,
    title: story.title,
    author: story.submitter_user ?? null,
    description: `Lobsters story by ${story.submitter_user ?? 'unknown'} (${story.score ?? 0} points)`,
    content,
    links: story.url ? [{ text: story.title, href: story.url }] : [],
    images: [],
    metadata: { type: 'article', publishedAt: story.created_at ?? null, source: 'lobsters-json', canonical: url, siteName: 'Lobsters' },
    cost: { tokens: estimateTokens(content) },
  };
}
