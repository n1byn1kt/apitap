// src/read/types.ts
import type { ReadFinding } from '../trapaware/types.js';

export interface PeekResult {
  url: string;
  status: number;
  accessible: boolean;
  contentType: string | null;
  server: string | null;
  framework: string | null;
  botProtection: string | null;
  signals: string[];
  recommendation: 'read' | 'capture' | 'auth_required' | 'blocked';
}

export interface ReadResult {
  url: string;
  title: string | null;
  author: string | null;
  description: string | null;
  content: string;
  links: Array<{ text: string; href: string }>;
  images: Array<{ alt: string; src: string }>;
  /** Number of links dropped by dedupe/caps. Absent on the legacy (scan: false) path. */
  linksOmitted?: number;
  /** Number of images dropped (all of them unless includeImages). Absent on the legacy path. */
  imagesOmitted?: number;
  metadata: {
    type: string;
    publishedAt: string | null;
    source: string;
    canonical: string | null;
    siteName: string | null;
  };
  cost: { tokens: number };
  /** Trap scanner findings. Present when the scanner ran. Absent when scan: false. */
  findings?: ReadFinding[];
}

export interface Decoder {
  name: string;
  patterns: RegExp[];
  decode(url: string, options?: { skipSsrf?: boolean; [key: string]: any }): Promise<ReadResult | null>;
}
