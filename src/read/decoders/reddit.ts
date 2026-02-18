// src/read/decoders/reddit.ts
import type { Decoder, ReadResult } from '../types.js';
import { safeFetch } from '../../discovery/fetch.js';

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export const redditDecoder: Decoder = {
  name: 'reddit',
  patterns: [
    /reddit\.com\/r\/[^/]+\/comments\//,
    /reddit\.com\/r\/[^/]+\/?$/,
    /reddit\.com\/r\/[^/]+\/?(?:\?|$)/,
    /reddit\.com\/user\/[^/]+/,
  ],

  async decode(url: string, options: { skipSsrf?: boolean; [key: string]: any } = {}): Promise<ReadResult | null> {
    try {
      // Append .json to the URL to get JSON response
      const jsonUrl = url.replace(/\/?(\?|$)/, '.json$1');

      const result = await safeFetch(jsonUrl, { skipSsrf: options.skipSsrf });
      if (!result || result.status !== 200) return null;

      let data: any;
      try {
        data = JSON.parse(result.body);
      } catch {
        return null;
      }

      // Post page: response is an array [post, comments]
      if (Array.isArray(data) && data.length >= 1) {
        return decodePostPage(url, data);
      }

      // Subreddit/user listing: response has data.children
      if (data && data.data && Array.isArray(data.data.children)) {
        return decodeListingPage(url, data);
      }

      return null;
    } catch {
      return null;
    }
  },
};

/**
 * Recover deleted/removed Reddit comments via PullPush archive.
 * PullPush indexes Reddit comments continuously; deleted content
 * may still be available if it was captured before deletion.
 */
async function recoverDeletedComments(
  commentIds: string[],
): Promise<Map<string, { author: string; body: string }>> {
  const recovered = new Map<string, { author: string; body: string }>();
  if (commentIds.length === 0) return recovered;

  try {
    const ids = commentIds.join(',');
    const ppUrl = `https://api.pullpush.io/reddit/search/comment/?ids=${ids}`;
    const response = await fetch(ppUrl, {
      headers: { 'user-agent': 'apitap/1.0 (deleted comment recovery)' },
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) return recovered;

    const result = await response.json() as any;
    const data = result?.data;
    if (!Array.isArray(data)) return recovered;

    for (const comment of data) {
      if (comment.id && comment.body && comment.body !== '[deleted]' && comment.body !== '[removed]') {
        recovered.set(comment.id, {
          author: comment.author || '[deleted]',
          body: comment.body,
        });
      }
    }
  } catch {
    // PullPush unavailable — silently skip recovery
  }

  return recovered;
}

async function decodePostPage(url: string, data: any[]): Promise<ReadResult | null> {
  try {
    const postData = data[0]?.data?.children?.[0]?.data;
    if (!postData) return null;

    const title = postData.title || null;
    const author = postData.author || null;
    const selftext = postData.selftext || '';
    const score = postData.score ?? 0;
    const subreddit = postData.subreddit || '';

    // Extract comments
    const commentChildren = data[1]?.data?.children || [];
    let comments = commentChildren
      .filter((c: any) => c.kind === 't1' && c.data)
      .slice(0, 25)
      .map((c: any) => ({
        id: c.data.id || '',
        author: c.data.author || '[deleted]',
        body: c.data.body || '',
        score: c.data.score ?? 0,
      }));

    // Recover deleted/removed comments via PullPush archive
    const deletedComments = comments.filter(
      (c: any) => (c.body === '[deleted]' || c.body === '[removed]') && c.id
    );
    if (deletedComments.length > 0) {
      const recovered = await recoverDeletedComments(deletedComments.map((c: any) => c.id));
      if (recovered.size > 0) {
        comments = comments.map((c: any) => {
          const original = recovered.get(c.id);
          if (original) {
            return {
              ...c,
              author: original.author || c.author,
              body: original.body,
              recovered: true,
            };
          }
          return c;
        });
      }
    }

    const commentText = comments
      .map((c: any) => {
        const prefix = c.recovered ? '[recovered] ' : '';
        return `${prefix}${c.author} (${c.score} pts): ${c.body}`;
      })
      .join('\n\n');

    const content = selftext
      ? `${selftext}\n\n---\nScore: ${score} | ${comments.length} comments\n\n${commentText}`
      : `Score: ${score} | ${comments.length} comments\n\n${commentText}`;

    const links: Array<{ text: string; href: string }> = [];
    if (postData.url && postData.url !== postData.permalink) {
      links.push({ text: 'Link', href: postData.url });
    }

    return {
      url,
      title,
      author,
      description: `r/${subreddit} post by u/${author} (${score} points)`,
      content,
      links,
      images: [],
      metadata: {
        type: 'discussion',
        publishedAt: postData.created_utc ? new Date(postData.created_utc * 1000).toISOString() : null,
        source: 'reddit-json',
        canonical: postData.permalink ? `https://www.reddit.com${postData.permalink}` : null,
        siteName: 'Reddit',
      },
      cost: { tokens: estimateTokens(content) },
    };
  } catch {
    return null;
  }
}

function decodeListingPage(url: string, data: any): ReadResult | null {
  try {
    const children = data.data.children || [];
    const posts = children
      .filter((c: any) => c.data)
      .slice(0, 25)
      .map((c: any) => ({
        title: c.data.title || c.data.link_title || '',
        author: c.data.author || '[deleted]',
        score: c.data.score ?? 0,
        numComments: c.data.num_comments ?? 0,
        permalink: c.data.permalink || '',
        subreddit: c.data.subreddit || '',
      }));

    const content = posts
      .map((p: any, i: number) => `${i + 1}. ${p.title} (${p.score} pts, ${p.numComments} comments) by u/${p.author}`)
      .join('\n');

    const links = posts
      .filter((p: any) => p.permalink)
      .map((p: any) => ({ text: p.title, href: `https://www.reddit.com${p.permalink}` }));

    // Try to determine subreddit name from URL
    const subMatch = url.match(/\/r\/([^/]+)/);
    const subreddit = subMatch ? subMatch[1] : null;
    const userMatch = url.match(/\/user\/([^/]+)/);
    const user = userMatch ? userMatch[1] : null;

    const title = subreddit ? `r/${subreddit}` : user ? `u/${user}` : 'Reddit listing';

    return {
      url,
      title,
      author: null,
      description: `${posts.length} posts`,
      content,
      links,
      images: [],
      metadata: {
        type: 'listing',
        publishedAt: null,
        source: 'reddit-json',
        canonical: null,
        siteName: 'Reddit',
      },
      cost: { tokens: estimateTokens(content) },
    };
  } catch {
    return null;
  }
}
