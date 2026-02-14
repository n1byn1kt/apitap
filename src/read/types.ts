// src/read/types.ts

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
  metadata: {
    type: string;
    publishedAt: string | null;
    source: string;
    canonical: string | null;
    siteName: string | null;
  };
  cost: { tokens: number };
}

export interface Decoder {
  name: string;
  patterns: RegExp[];
  decode(url: string, options?: { skipSsrf?: boolean; [key: string]: any }): Promise<ReadResult | null>;
}
