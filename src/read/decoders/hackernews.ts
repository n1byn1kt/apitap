// src/read/decoders/hackernews.ts
import type { Decoder, ReadResult } from '../types.js';
import { safeFetch } from '../../discovery/fetch.js';

const DEFAULT_API_BASE = 'https://hacker-news.firebaseio.com';

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export const hackernewsDecoder: Decoder = {
  name: 'hackernews',
  patterns: [
    /news\.ycombinator\.com\/item\?id=\d+/,
    /news\.ycombinator\.com\/?(?:\?|$)/,
  ],

  async decode(url: string, options: { skipSsrf?: boolean; [key: string]: any } = {}): Promise<ReadResult | null> {
    try {
      const apiBase = options._apiBaseUrl || DEFAULT_API_BASE;
      const fetchOpts = { skipSsrf: options.skipSsrf };

      // Check if this is an item page or front page
      const itemMatch = url.match(/item\?id=(\d+)/);

      if (itemMatch) {
        return decodeItem(url, itemMatch[1], apiBase, fetchOpts);
      }

      return decodeFrontPage(url, apiBase, fetchOpts);
    } catch {
      return null;
    }
  },
};

async function decodeItem(
  url: string,
  id: string,
  apiBase: string,
  fetchOpts: { skipSsrf?: boolean },
): Promise<ReadResult | null> {
  try {
    const result = await safeFetch(`${apiBase}/v0/item/${id}.json`, fetchOpts);
    if (!result || result.status !== 200) return null;

    let item: any;
    try {
      item = JSON.parse(result.body);
    } catch {
      return null;
    }

    if (!item) return null;

    const title = item.title || null;
    const author = item.by || null;
    const score = item.score ?? 0;
    const itemUrl = item.url || null;
    const text = item.text || '';

    // Fetch top 10 comments
    const kids = item.kids || [];
    const commentIds = kids.slice(0, 10);
    const comments = await fetchComments(commentIds, apiBase, fetchOpts);

    const commentText = comments
      .map((c: any) => `${c.by || '[deleted]'}: ${c.text || '[deleted]'}`)
      .join('\n\n');

    const contentParts: string[] = [];
    if (text) contentParts.push(text);
    contentParts.push(`Score: ${score} | ${kids.length} comments`);
    if (commentText) contentParts.push(`---\n${commentText}`);
    const content = contentParts.join('\n\n');

    const links: Array<{ text: string; href: string }> = [];
    if (itemUrl) {
      links.push({ text: title || 'Link', href: itemUrl });
    }

    return {
      url,
      title,
      author,
      description: `HN ${item.type || 'story'} by ${author} (${score} points)`,
      content,
      links,
      images: [],
      metadata: {
        type: item.type || 'story',
        publishedAt: item.time ? new Date(item.time * 1000).toISOString() : null,
        source: 'hackernews-firebase',
        canonical: `https://news.ycombinator.com/item?id=${id}`,
        siteName: 'Hacker News',
      },
      cost: { tokens: estimateTokens(content) },
    };
  } catch {
    return null;
  }
}

async function decodeFrontPage(
  url: string,
  apiBase: string,
  fetchOpts: { skipSsrf?: boolean },
): Promise<ReadResult | null> {
  try {
    const result = await safeFetch(`${apiBase}/v0/topstories.json`, fetchOpts);
    if (!result || result.status !== 200) return null;

    let storyIds: number[];
    try {
      storyIds = JSON.parse(result.body);
    } catch {
      return null;
    }

    if (!Array.isArray(storyIds)) return null;

    // Fetch first 10 stories
    const topIds = storyIds.slice(0, 10);
    const stories = await fetchStories(topIds, apiBase, fetchOpts);

    const content = stories
      .map((s: any, i: number) => `${i + 1}. ${s.title || '[untitled]'} (${s.score ?? 0} pts, ${(s.descendants ?? 0)} comments) by ${s.by || '[deleted]'}`)
      .join('\n');

    const links = stories
      .filter((s: any) => s.url)
      .map((s: any) => ({ text: s.title || 'Link', href: s.url }));

    return {
      url,
      title: 'Hacker News — Top Stories',
      author: null,
      description: `Top ${stories.length} stories`,
      content,
      links,
      images: [],
      metadata: {
        type: 'listing',
        publishedAt: null,
        source: 'hackernews-firebase',
        canonical: 'https://news.ycombinator.com/',
        siteName: 'Hacker News',
      },
      cost: { tokens: estimateTokens(content) },
    };
  } catch {
    return null;
  }
}

async function fetchComments(
  ids: number[],
  apiBase: string,
  fetchOpts: { skipSsrf?: boolean },
): Promise<any[]> {
  const comments: any[] = [];
  for (const id of ids) {
    try {
      const result = await safeFetch(`${apiBase}/v0/item/${id}.json`, fetchOpts);
      if (result && result.status === 200) {
        const comment = JSON.parse(result.body);
        if (comment && !comment.deleted) {
          comments.push(comment);
        }
      }
    } catch {
      // skip failed comments
    }
  }
  return comments;
}

async function fetchStories(
  ids: number[],
  apiBase: string,
  fetchOpts: { skipSsrf?: boolean },
): Promise<any[]> {
  const stories: any[] = [];
  for (const id of ids) {
    try {
      const result = await safeFetch(`${apiBase}/v0/item/${id}.json`, fetchOpts);
      if (result && result.status === 200) {
        const story = JSON.parse(result.body);
        if (story) {
          stories.push(story);
        }
      }
    } catch {
      // skip failed stories
    }
  }
  return stories;
}
