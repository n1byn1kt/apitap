// src/read/extract.ts

export interface HeadMeta {
  title: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;
  ogType: string | null;
  ogSiteName: string | null;
  canonical: string | null;
  author: string | null;
  publishedTime: string | null;
}

export interface ExtractResult {
  content: string;
  links: Array<{ text: string; href: string }>;
  images: Array<{ alt: string; src: string }>;
  isSpaShell: boolean;
}

// ---- HTML entity decoding ----

const ENTITY_MAP: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/g, (m) => ENTITY_MAP[m] ?? m);
}

// ---- parseHead ----

function extractMetaContent(html: string, attrName: string, attrValue: string): string | null {
  // Handle both orders: property="X" content="Y" and content="Y" property="X"
  // Also handle name="X" content="Y" for author etc.
  const patterns = [
    new RegExp(`<meta\\s+${attrName}=["']${escapeRegex(attrValue)}["']\\s+content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta\\s+content=["']([^"']*)["']\\s+${attrName}=["']${escapeRegex(attrValue)}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return decodeEntities(m[1]);
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseHead(html: string): HeadMeta {
  // Extract <title>
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1].trim()) : null;

  // Extract canonical
  const canonicalMatch = html.match(/<link\s+[^>]*rel=["']canonical["'][^>]*href=["']([^"']*)["'][^>]*\/?>/i)
    ?? html.match(/<link\s+[^>]*href=["']([^"']*)["'][^>]*rel=["']canonical["'][^>]*\/?>/i);
  const canonical = canonicalMatch ? decodeEntities(canonicalMatch[1]) : null;

  return {
    title,
    ogTitle: extractMetaContent(html, 'property', 'og:title'),
    ogDescription: extractMetaContent(html, 'property', 'og:description'),
    ogImage: extractMetaContent(html, 'property', 'og:image'),
    ogType: extractMetaContent(html, 'property', 'og:type'),
    ogSiteName: extractMetaContent(html, 'property', 'og:site_name'),
    canonical,
    author: extractMetaContent(html, 'name', 'author'),
    publishedTime: extractMetaContent(html, 'property', 'article:published_time'),
  };
}

// ---- extractContent ----

/** Tags whose entire content (including children) should be removed */
const NOISE_TAGS = ['script', 'style', 'noscript', 'svg', 'iframe', 'nav', 'header', 'footer', 'aside'];

/** SPA shell markers */
const SPA_MARKERS = [
  '<div id="root"',
  '<div id="app"',
  '<div id="__next"',
  'bundle.js',
  'main.js',
  'app.js',
  '__NEXT_DATA__',
  'window.__INITIAL_STATE__',
  'window.__NUXT__',
];

function stripTags(html: string, tags: string[]): string {
  let result = html;
  for (const tag of tags) {
    // Use non-greedy match with dotAll behavior via [\s\S]
    const re = new RegExp(`<${tag}[\\s>][\\s\\S]*?<\\/${tag}>`, 'gi');
    result = result.replace(re, '');
    // Also strip self-closing variants (e.g. <iframe ... />)
    const selfClose = new RegExp(`<${tag}[^>]*/?>`, 'gi');
    result = result.replace(selfClose, '');
  }
  return result;
}

function findContentRoot(html: string): string {
  // Priority order for content root
  const selectors: Array<{ re: RegExp }> = [
    { re: /<article[^>]*>([\s\S]*?)<\/article>/i },
    { re: /<main[^>]*>([\s\S]*?)<\/main>/i },
    { re: /<[^>]+role=["']main["'][^>]*>([\s\S]*?)<\/div>/i },
  ];

  for (const { re } of selectors) {
    const m = html.match(re);
    if (m) return m[1];
  }

  // Class-based selectors
  const classPatterns = [
    /class=["'][^"']*\bpost-content\b/i,
    /class=["'][^"']*\barticle-body\b/i,
    /class=["'][^"']*\bentry-content\b/i,
  ];

  for (const cp of classPatterns) {
    const m = html.match(cp);
    if (m) {
      // Find the enclosing tag and extract its content
      const idx = m.index!;
      const extracted = extractTagContent(html, idx);
      if (extracted) return extracted;
    }
  }

  // id="content"
  const contentId = html.match(/id=["']content["']/i);
  if (contentId) {
    const extracted = extractTagContent(html, contentId.index!);
    if (extracted) return extracted;
  }

  // Fallback: <body>
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) return bodyMatch[1];

  return html;
}

function extractTagContent(html: string, attrIndex: number): string | null {
  // Walk backwards to find the opening < of the tag
  let tagStart = attrIndex;
  while (tagStart > 0 && html[tagStart] !== '<') tagStart--;

  // Find the tag name
  const tagNameMatch = html.slice(tagStart).match(/^<(\w+)/);
  if (!tagNameMatch) return null;

  const tagName = tagNameMatch[1];

  // Find matching close tag accounting for nesting
  let depth = 1;
  const openRe = new RegExp(`<${tagName}[\\s>]`, 'gi');
  const closeRe = new RegExp(`</${tagName}>`, 'gi');

  // Find where the opening tag ends (the first > after tagStart)
  const openTagEnd = html.indexOf('>', tagStart);
  if (openTagEnd === -1) return null;

  let pos = openTagEnd + 1;
  const contentStart = pos;

  while (depth > 0 && pos < html.length) {
    openRe.lastIndex = pos;
    closeRe.lastIndex = pos;

    const nextOpen = openRe.exec(html);
    const nextClose = closeRe.exec(html);

    if (!nextClose) break; // no more close tags

    if (nextOpen && nextOpen.index < nextClose.index) {
      depth++;
      pos = nextOpen.index + nextOpen[0].length;
    } else {
      depth--;
      if (depth === 0) {
        return html.slice(contentStart, nextClose.index);
      }
      pos = nextClose.index + nextClose[0].length;
    }
  }

  return null;
}

function htmlToMarkdown(
  html: string,
  links: Array<{ text: string; href: string }>,
  images: Array<{ alt: string; src: string }>,
): string {
  let md = html;

  // Remove HTML comments
  md = md.replace(/<!--[\s\S]*?-->/g, '');

  // Convert headings
  for (let level = 1; level <= 6; level++) {
    const prefix = '#'.repeat(level);
    const re = new RegExp(`<h${level}[^>]*>([\\s\\S]*?)<\\/h${level}>`, 'gi');
    md = md.replace(re, (_m, content) => {
      const text = stripAllTags(content).trim();
      return `\n\n${prefix} ${text}\n\n`;
    });
  }

  // Convert blockquotes (before paragraphs)
  md = md.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, content) => {
    const text = stripAllTags(content).trim();
    const quoted = text.split('\n').map((l: string) => `> ${l}`).join('\n');
    return `\n\n${quoted}\n\n`;
  });

  // Convert code blocks: <pre><code>...</code></pre>
  md = md.replace(/<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_m, content) => {
    const decoded = decodeEntities(content.trim());
    return `\n\n\`\`\`\n${decoded}\n\`\`\`\n\n`;
  });

  // Convert standalone <pre> (without <code>)
  md = md.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, content) => {
    const decoded = decodeEntities(stripAllTags(content).trim());
    return `\n\n\`\`\`\n${decoded}\n\`\`\`\n\n`;
  });

  // Convert inline code
  md = md.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, content) => {
    return `\`${decodeEntities(content)}\``;
  });

  // Convert tables
  md = md.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_m, tableContent) => {
    return convertTable(tableContent);
  });

  // Convert images (before stripping tags, so we can extract src/alt)
  md = md.replace(/<img\s+[^>]*>/gi, (tag) => {
    const srcMatch = tag.match(/src=["']([^"']*)["']/i);
    const altMatch = tag.match(/alt=["']([^"']*)["']/i);
    const src = srcMatch ? decodeEntities(srcMatch[1]) : '';
    const alt = altMatch ? decodeEntities(altMatch[1]) : '';
    if (src) {
      images.push({ alt, src });
      return `![${alt}](${src})`;
    }
    return '';
  });

  // Convert links
  md = md.replace(/<a\s+[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, content) => {
    const text = stripAllTags(content).trim();
    const decodedHref = decodeEntities(href);
    if (text && decodedHref) {
      links.push({ text, href: decodedHref });
      return `[${text}](${decodedHref})`;
    }
    return text;
  });

  // Convert bold
  md = md.replace(/<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, (_m, content) => {
    return `**${stripAllTags(content)}**`;
  });

  // Convert italic
  md = md.replace(/<(?:em|i)(?:\s[^>]*)?>(?!mg)([\s\S]*?)<\/(?:em|i)>/gi, (_m, content) => {
    return `*${stripAllTags(content)}*`;
  });

  // Convert ordered lists
  md = md.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_m, listContent) => {
    let counter = 0;
    const items = listContent.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_lm: string, item: string) => {
      counter++;
      return `${counter}. ${stripAllTags(item).trim()}\n`;
    });
    return `\n\n${stripAllTags(items).trim()}\n\n`;
  });

  // Convert unordered lists
  md = md.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_m, listContent) => {
    const items = listContent.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_lm: string, item: string) => {
      return `- ${stripAllTags(item).trim()}\n`;
    });
    return `\n\n${stripAllTags(items).trim()}\n\n`;
  });

  // Convert paragraphs
  md = md.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_m, content) => {
    return `\n\n${content.trim()}\n\n`;
  });

  // Convert <br> tags
  md = md.replace(/<br\s*\/?>/gi, '\n');

  // Strip remaining HTML tags
  md = stripAllTags(md);

  // Decode entities
  md = decodeEntities(md);

  // Collapse whitespace: no more than 2 consecutive newlines
  md = md.replace(/\n{3,}/g, '\n\n');

  // Trim leading/trailing whitespace
  md = md.trim();

  return md;
}

function stripAllTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

function convertTable(tableHtml: string): string {
  const rows: string[][] = [];

  // Extract rows
  const rowMatches = tableHtml.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  for (const row of rowMatches) {
    const cells: string[] = [];
    const cellMatches = row.match(/<(?:td|th)[^>]*>[\s\S]*?<\/(?:td|th)>/gi) || [];
    for (const cell of cellMatches) {
      const content = cell.replace(/<\/?(?:td|th)[^>]*>/gi, '');
      cells.push(stripAllTags(content).trim());
    }
    if (cells.length > 0) rows.push(cells);
  }

  if (rows.length === 0) return '';

  // Normalize column count
  const maxCols = Math.max(...rows.map((r) => r.length));
  const normalized = rows.map((r) => {
    while (r.length < maxCols) r.push('');
    return r;
  });

  // Build markdown table
  const lines: string[] = [];
  const header = normalized[0];
  lines.push('| ' + header.join(' | ') + ' |');
  lines.push('| ' + header.map(() => '---').join(' | ') + ' |');

  for (let i = 1; i < normalized.length; i++) {
    lines.push('| ' + normalized[i].join(' | ') + ' |');
  }

  return '\n\n' + lines.join('\n') + '\n\n';
}

function getTextContent(html: string): string {
  return stripAllTags(html).replace(/\s+/g, ' ').trim();
}

export function extractContent(html: string): ExtractResult {
  const links: Array<{ text: string; href: string }> = [];
  const images: Array<{ alt: string; src: string }> = [];

  // Strip noise tags first
  const cleaned = stripTags(html, NOISE_TAGS);

  // Find content root
  const contentHtml = findContentRoot(cleaned);

  // Convert to markdown
  const content = htmlToMarkdown(contentHtml, links, images);

  // Detect SPA shell
  const textContent = getTextContent(contentHtml);
  const hasSpaMarker = SPA_MARKERS.some((marker) => html.includes(marker));
  const isSpaShell = textContent.length < 200 && hasSpaMarker;

  return {
    content,
    links,
    images,
    isSpaShell,
  };
}
