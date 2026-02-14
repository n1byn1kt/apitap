// src/read/decoders/twitter.ts
import type { Decoder, ReadResult } from '../types.js';
import { safeFetch } from '../../discovery/fetch.js';

const DEFAULT_API_BASE = 'https://api.fxtwitter.com';

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Twitter/X decoder — uses fxtwitter.com public API as side channel.
 *
 * Handles:
 *   - Individual tweets/posts (with text, media, quotes, articles)
 *   - Profile URLs (basic profile info)
 *
 * fxtwitter API returns full tweet JSON including embedded articles,
 * media URLs, quote tweets, and engagement metrics — all without auth.
 */
export const twitterDecoder: Decoder = {
  name: 'twitter',
  patterns: [
    /(?:twitter\.com|x\.com)\/\w+\/status\/\d+/,
    /(?:twitter\.com|x\.com)\/(\w+)\/?$/,
  ],

  async decode(url: string, options: { skipSsrf?: boolean; [key: string]: any } = {}): Promise<ReadResult | null> {
    try {
      const apiBase = options._apiBaseUrl || DEFAULT_API_BASE;

      // Tweet/status URL
      const statusMatch = url.match(/(?:twitter\.com|x\.com)\/(\w+)\/status\/(\d+)/);
      if (statusMatch) {
        return decodeTweet(apiBase, statusMatch[1], statusMatch[2], url, options);
      }

      // Profile URL
      const profileMatch = url.match(/(?:twitter\.com|x\.com)\/(\w+)\/?$/);
      if (profileMatch && !isReservedPath(profileMatch[1])) {
        return decodeProfile(apiBase, profileMatch[1], url, options);
      }

      return null;
    } catch {
      return null;
    }
  },
};

function isReservedPath(path: string): boolean {
  const reserved = new Set([
    'home', 'explore', 'search', 'notifications', 'messages',
    'settings', 'i', 'compose', 'hashtag', 'login', 'signup',
  ]);
  return reserved.has(path.toLowerCase());
}

async function decodeTweet(
  apiBase: string,
  username: string,
  tweetId: string,
  url: string,
  options: { skipSsrf?: boolean; [key: string]: any },
): Promise<ReadResult | null> {
  const apiUrl = `${apiBase}/${username}/status/${tweetId}`;
  const result = await safeFetch(apiUrl, { skipSsrf: options.skipSsrf });
  if (!result || result.status !== 200) return null;

  let data: any;
  try {
    data = JSON.parse(result.body);
  } catch {
    return null;
  }

  const tweet = data?.tweet;
  if (!tweet) return null;

  const author = tweet.author;
  const authorName = author ? `${author.name} (@${author.screen_name})` : username;

  // Build content
  const parts: string[] = [];

  // Author info
  if (author) {
    parts.push(`**${author.name}** (@${author.screen_name})`);
    if (author.description) parts.push(author.description);
    if (author.followers) parts.push(`Followers: ${Number(author.followers).toLocaleString()}`);
  }

  // Tweet text
  const tweetText = tweet.text || tweet.raw_text?.text || '';
  if (tweetText) parts.push(`\n${tweetText}`);

  // Engagement
  const engagement: string[] = [];
  if (tweet.likes) engagement.push(`${Number(tweet.likes).toLocaleString()} likes`);
  if (tweet.retweets) engagement.push(`${Number(tweet.retweets).toLocaleString()} RTs`);
  if (tweet.views) engagement.push(`${Number(tweet.views).toLocaleString()} views`);
  if (tweet.bookmarks) engagement.push(`${Number(tweet.bookmarks).toLocaleString()} bookmarks`);
  if (engagement.length > 0) parts.push(engagement.join(' · '));

  // Embedded article (X Articles / long-form posts)
  if (tweet.article) {
    const article = tweet.article;
    parts.push(`\n## ${article.title || 'Article'}`);

    if (article.content?.blocks) {
      const articleText = extractArticleBlocks(article.content.blocks);
      parts.push(articleText);
    } else if (article.preview_text) {
      parts.push(article.preview_text);
    }
  }

  // Quote tweet
  if (tweet.quote) {
    const q = tweet.quote;
    const qAuthor = q.author ? `${q.author.name} (@${q.author.screen_name})` : 'Unknown';
    const qText = q.text || '';
    parts.push(`\n> Quoting ${qAuthor}:\n> ${qText}`);
  }

  const content = parts.join('\n');

  // Links
  const links: Array<{ text: string; href: string }> = [];
  if (author?.website?.url) {
    links.push({ text: author.website.display_url || 'Website', href: author.website.url });
  }

  // Images
  const images: Array<{ alt: string; src: string }> = [];
  if (tweet.media?.photos) {
    for (const photo of tweet.media.photos.slice(0, 4)) {
      images.push({ alt: 'Tweet image', src: photo.url });
    }
  }
  if (tweet.article?.cover_media?.media_info?.original_img_url) {
    images.push({
      alt: tweet.article.title || 'Article cover',
      src: tweet.article.cover_media.media_info.original_img_url,
    });
  }

  return {
    url,
    title: tweet.article?.title || (tweetText ? `${authorName}: ${tweetText.slice(0, 80)}${tweetText.length > 80 ? '…' : ''}` : `Tweet by ${authorName}`),
    author: author?.name || username,
    description: tweetText?.slice(0, 200) || null,
    content,
    links,
    images,
    metadata: {
      type: tweet.article ? 'article' : 'social',
      publishedAt: tweet.created_at || null,
      source: 'twitter-fxtwitter',
      canonical: url,
      siteName: 'X (Twitter)',
    },
    cost: { tokens: estimateTokens(content) },
  };
}

function extractArticleBlocks(blocks: any[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    const text = block.text || '';
    if (!text) continue;

    switch (block.type) {
      case 'header-one':
        parts.push(`\n# ${text}`);
        break;
      case 'header-two':
        parts.push(`\n## ${text}`);
        break;
      case 'header-three':
        parts.push(`\n### ${text}`);
        break;
      case 'unordered-list-item':
        parts.push(`• ${text}`);
        break;
      case 'ordered-list-item':
        parts.push(`1. ${text}`);
        break;
      case 'blockquote':
        parts.push(`> ${text}`);
        break;
      default:
        parts.push(text);
        break;
    }
  }
  return parts.join('\n');
}

async function decodeProfile(
  apiBase: string,
  username: string,
  url: string,
  options: { skipSsrf?: boolean; [key: string]: any },
): Promise<ReadResult | null> {
  // fxtwitter doesn't have a dedicated profile endpoint,
  // but we can get profile data from any tweet by the user.
  // For now, return null and let generic decoder handle profiles.
  // Profile data is included in tweet responses anyway.
  return null;
}
