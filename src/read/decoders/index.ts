// src/read/decoders/index.ts
import type { Decoder } from '../types.js';
import { redditDecoder } from './reddit.js';
import { youtubeDecoder } from './youtube.js';
import { wikipediaDecoder } from './wikipedia.js';
import { hackernewsDecoder } from './hackernews.js';
import { grokipediaDecoder } from './grokipedia.js';
import { twitterDecoder } from './twitter.js';

const decoders: Decoder[] = [redditDecoder, youtubeDecoder, wikipediaDecoder, hackernewsDecoder, grokipediaDecoder, twitterDecoder];

export function findDecoder(url: string): Decoder | null {
  return decoders.find(d => d.patterns.some(p => p.test(url))) ?? null;
}
